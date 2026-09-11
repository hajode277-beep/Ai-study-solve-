import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const PORT = 3000;
const app = express();

// Universal CORS middleware & preflight handling for seamless iframe & dev-environment communication
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// Support large payloads for image-based homework questions
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Helper to determine the best working key
function getEffectiveApiKey(clientApiKey?: string): string {
  const custom = (clientApiKey || '').trim();
  // If the user provided an explicit personal key starting with standard AIza prefix, use it
  if (custom && custom.startsWith('AIza')) {
    return custom;
  }
  // Otherwise use the platform-provided server environment key
  return (process.env.GEMINI_API_KEY || '').trim();
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    aiConfigured: Boolean(process.env.GEMINI_API_KEY),
    timestamp: new Date().toISOString(),
  });
});

// Test key endpoint
app.post('/api/test-key', async (req, res) => {
  try {
    const key = getEffectiveApiKey(req.body?.apiKey);
    if (!key) {
      res.status(400).json({ error: { message: 'No Gemini API key available in server environment.' } });
      return;
    }

    const ai = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const preferredModel = req.body?.model || 'gemini-3.1-flash-lite';
    let response: any = null;
    let usedModel = preferredModel;

    // Try preferred model, fallback to gemini-3.1-flash-lite if high demand (503) or quota limit (429)
    try {
      response = await Promise.race([
        ai.models.generateContent({
          model: preferredModel,
          contents: 'Respond with OK',
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Model check timed out')), 4000)),
      ]);
    } catch (prefErr: any) {
      console.warn(`Test key with ${preferredModel} failed, trying gemini-3.1-flash-lite:`, prefErr.message);
      usedModel = 'gemini-3.1-flash-lite';
      response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: 'Respond with OK',
      });
    }

    const resText = response?.text || 'OK';
    res.json({
      valid: true,
      candidates: [{ content: { parts: [{ text: resText }] } }],
      modelUsed: usedModel,
      text: resText,
    });
  } catch (err: any) {
    console.error('Test key error:', err);
    res.status(500).json({
      error: {
        message: err.message || 'Verification failed',
      },
    });
  }
});

// Gemini solve proxy endpoint
app.post('/api/gemini', async (req, res) => {
  try {
    const { model, payload = {}, clientApiKey } = req.body || {};
    const key = getEffectiveApiKey(clientApiKey);

    if (!key) {
      res.status(500).json({
        error: {
          message: 'Server Gemini API key is missing. Please ensure GEMINI_API_KEY is configured in Secrets.',
        },
      });
      return;
    }

    const ai = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    // Models priority cascade: always prioritize ultra-fast gemini-3.1-flash-lite
    const requested = (model && !model.includes('gemini-2.5')) ? model : 'gemini-3.1-flash-lite';
    // If requested model is already flash-lite, test it first; otherwise test requested with short timeout then flash-lite
    const modelsToTry = requested === 'gemini-3.1-flash-lite'
      ? ['gemini-3.1-flash-lite']
      : [requested, 'gemini-3.1-flash-lite'];

    // Convert REST-style contents and systemInstruction to SDK parameters
    const userParts: any[] = [];
    if (payload.contents && Array.isArray(payload.contents)) {
      for (const item of payload.contents) {
        if (item.parts && Array.isArray(item.parts)) {
          for (const p of item.parts) {
            if (p.text) {
              userParts.push({ text: p.text });
            } else if (p.inlineData) {
              userParts.push({
                inlineData: {
                  mimeType: p.inlineData.mimeType,
                  data: p.inlineData.data,
                },
              });
            }
          }
        }
      }
    }

    // Extract system instruction string
    let systemInstructionText = 'You are an expert academic tutor and problem solver.';
    if (payload.systemInstruction?.parts?.[0]?.text) {
      systemInstructionText = payload.systemInstruction.parts[0].text;
    } else if (typeof payload.systemInstruction === 'string') {
      systemInstructionText = payload.systemInstruction;
    }

    const temp = typeof payload.generationConfig?.temperature === 'number'
      ? payload.generationConfig.temperature
      : 0.2;
    const maxTokens = payload.generationConfig?.maxOutputTokens || 1200;

    let lastError: any = null;

    // Helper function to try generating content with or without tools and with timeout
    const tryGenerateWithModel = async (m: string, includeTools: boolean, timeoutMs: number) => {
      const config: any = {
        systemInstruction: systemInstructionText,
        temperature: temp,
        maxOutputTokens: maxTokens,
      };

      if (includeTools && payload.tools && Array.isArray(payload.tools) && payload.tools.length > 0) {
        config.tools = payload.tools;
      }

      const callPromise = ai.models.generateContent({
        model: m,
        contents: userParts.length > 0 ? userParts : 'Solve this question step by step.',
        config,
      });

      return await Promise.race([
        callPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Model ${m} timed out after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);
    };

    // Helper to safely extract generated output text
    const extractText = (resp: any): string => {
      let txt = '';
      try {
        txt = resp?.text || '';
      } catch (_) {}
      if (!txt && resp?.candidates?.[0]?.content?.parts) {
        txt = resp.candidates[0].content.parts.map((p: any) => p.text || '').filter(Boolean).join('\n');
      }
      return txt;
    };

    for (const m of modelsToTry) {
      const timeoutForModel = m === 'gemini-3.1-flash-lite' ? 22000 : 3500;
      try {
        const response = await tryGenerateWithModel(m, true, timeoutForModel);
        const outputText = extractText(response);
        if (outputText) {
          res.json({
            candidates: [
              {
                content: {
                  parts: [{ text: outputText }],
                  role: 'model',
                },
                finishReason: 'STOP',
              },
            ],
            text: outputText,
            modelUsed: m,
          });
          return;
        }
      } catch (callErr: any) {
        console.warn(`Model attempt ${m} with tools failed:`, callErr.message);
        lastError = callErr;

        // If error might be due to tools (such as quota 429 on Search Grounding or tool error), retry without tools
        if (payload.tools && payload.tools.length > 0) {
          try {
            console.log(`Retrying model ${m} without tools...`);
            const fallbackResponse = await tryGenerateWithModel(m, false, timeoutForModel);
            const outputText = extractText(fallbackResponse);
            if (outputText) {
              res.json({
                candidates: [
                  {
                    content: {
                      parts: [{ text: outputText }],
                      role: 'model',
                    },
                    finishReason: 'STOP',
                  },
                ],
                text: outputText,
                modelUsed: m,
              });
              return;
            }
          } catch (retryErr: any) {
            console.warn(`Model attempt ${m} without tools failed:`, retryErr.message);
            lastError = retryErr;
          }
        }
      }
    }

    // Fallback: If SDK attempts hit specific limits, try direct fetch with key
    const restModels = ['gemini-3.1-flash-lite'];
    for (const m of restModels) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`;
        // Try with payload as-is
        let restRes = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        let restJson = await restRes.json();
        if (restRes.ok && restJson.candidates && restJson.candidates.length > 0) {
          restJson.modelUsed = m;
          res.json(restJson);
          return;
        }
        
        // If tools failed, try without tools
        if (payload.tools) {
          const strippedPayload = { ...payload };
          delete strippedPayload.tools;
          restRes = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(strippedPayload),
          });
          restJson = await restRes.json();
          if (restRes.ok && restJson.candidates && restJson.candidates.length > 0) {
            restJson.modelUsed = m;
            res.json(restJson);
            return;
          }
        }
        lastError = restJson.error || lastError;
      } catch (fetchErr: any) {
        lastError = fetchErr;
      }
    }

    const statusCode = lastError?.code || 500;
    res.status(typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
      error: {
        message: lastError?.message || 'Failed to generate solution. Please try again.',
      },
    });
  } catch (err: any) {
    console.error('Unhandled Gemini proxy error:', err);
    res.status(500).json({
      error: {
        message: err.message || 'Internal proxy error',
      },
    });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`StudySolve AI server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
