import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {defineConfig, Plugin} from 'vite';

// LINT.IfChange(aistudio_media_plugin)
function aistudioMediaPlugin(): Plugin {
  return {
    name: 'vite-plugin-aistudio-media',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith('/assets/aistudio/')) {
          const rawPath = req.url.split('?')[0].split('#')[0];
          try {
            const decodedPath = decodeURIComponent(rawPath);
            const relativePath = decodedPath.replace(/^\//, '');
            const aistudioDir = path.resolve(
              __dirname,
              'public',
              'assets',
              'aistudio',
            );
            const filePath = path.resolve(__dirname, 'public', relativePath);
            if (
              filePath.startsWith(aistudioDir + path.sep) &&
              fs.existsSync(filePath) &&
              fs.statSync(filePath).isFile()
            ) {
              const ext = path.extname(filePath).toLowerCase();
              const mimeMap: Record<string, string> = {
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.png': 'image/png',
                '.gif': 'image/gif',
                '.webp': 'image/webp',
                '.svg': 'image/svg+xml',
                '.bmp': 'image/bmp',
                '.ico': 'image/x-icon',
                '.mp4': 'video/mp4',
                '.webm': 'video/webm',
                '.ogv': 'video/ogg',
                '.mp3': 'audio/mpeg',
                '.wav': 'audio/wav',
                '.ogg': 'audio/ogg',
                '.pdf': 'application/pdf',
              };
              res.setHeader(
                'Content-Type',
                mimeMap[ext] || 'application/octet-stream',
              );
              res.setHeader('Cache-Control', 'no-cache');
              fs.createReadStream(filePath).pipe(res);
              return;
            }
          } catch {
            // Fall through if URI decoding or file access fails
          }
        }
        next();
      });
    },
  };
}
// LINT.ThenChange(//depot/google3/java/com/google/alkali/boq/makersuite/applet_dev_service/templates/initializers/react_theme/vite.config.ts:aistudio_media_plugin)

function getEffectiveKey(clientKey?: string): string {
  const custom = (clientKey || '').trim();
  if (custom && custom.startsWith('AIza')) {
    return custom;
  }
  return (process.env.GEMINI_API_KEY || '').trim();
}

function geminiApiPlugin(): Plugin {
  return {
    name: 'vite-plugin-gemini-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ? req.url.split('?')[0] : '';

        // Ultra-fast Gemini proxy endpoint
        if (url === '/api/gemini' && req.method === 'POST') {
          let bodyStr = '';
          req.on('data', chunk => { bodyStr += chunk; });
          req.on('end', async () => {
            try {
              const body = JSON.parse(bodyStr || '{}');
              const apiKey = getEffectiveKey(body.clientApiKey);

              if (!apiKey) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: { message: 'GEMINI_API_KEY is not configured on the server.' } }));
                return;
              }

              // Extract and prepare payload
              const payload = body.payload || {};
              payload.generationConfig = {
                temperature: 0.15,
                maxOutputTokens: 1100,
                ...(payload.generationConfig || {}),
                thinkingConfig: { thinkingLevel: 'MINIMAL' }
              };

              const requestedModel = body.model && !body.model.includes('gemini-2.5') ? body.model : 'gemini-3.1-flash-lite';
              const modelsToTry = [
                requestedModel,
                'gemini-3.1-flash-lite',
                'gemini-3.8-flash'
              ];
              const uniqueModels = [...new Set(modelsToTry)];

              // 1. Try with @google/genai SDK first
              try {
                const ai = new GoogleGenAI({
                  apiKey,
                  httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
                });

                // Extract parts
                const userParts: any[] = [];
                if (payload.contents && Array.isArray(payload.contents)) {
                  for (const c of payload.contents) {
                    if (c.parts && Array.isArray(c.parts)) {
                      for (const p of c.parts) {
                        if (p.text) userParts.push({ text: p.text });
                        else if (p.inlineData) userParts.push({ inlineData: p.inlineData });
                      }
                    }
                  }
                }

                let sysPrompt = 'You are an expert academic tutor and problem solver.';
                if (payload.systemInstruction?.parts?.[0]?.text) {
                  sysPrompt = payload.systemInstruction.parts[0].text;
                }

                const sdkResponse = await ai.models.generateContent({
                  model: uniqueModels[0],
                  contents: userParts.length > 0 ? userParts : 'Solve this question step by step.',
                  config: {
                    systemInstruction: sysPrompt,
                    temperature: payload.generationConfig?.temperature || 0.2,
                    maxOutputTokens: payload.generationConfig?.maxOutputTokens || 1100,
                    tools: payload.tools || undefined
                  }
                });

                if (sdkResponse.text) {
                  res.statusCode = 200;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({
                    candidates: [{
                      content: { parts: [{ text: sdkResponse.text }], role: 'model' },
                      finishReason: 'STOP'
                    }],
                    text: sdkResponse.text,
                    modelUsed: uniqueModels[0]
                  }));
                  return;
                }
              } catch (sdkErr: any) {
                console.warn('Vite SDK attempt fallback to REST:', sdkErr.message);
              }

              // 2. Direct REST fallback
              let successData: any = null;
              let lastStatus = 500;
              let lastErrData: any = null;

              for (const m of uniqueModels) {
                try {
                  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
                  const apiRes = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                  });

                  const resJson = await apiRes.json();
                  if (apiRes.ok && resJson.candidates && resJson.candidates.length > 0) {
                    successData = resJson;
                    successData.modelUsed = m;
                    break;
                  } else {
                    lastStatus = apiRes.status;
                    lastErrData = resJson;
                  }
                } catch (fetchErr: any) {
                  console.warn(`Model ${m} fetch error:`, fetchErr.message);
                }
              }

              if (successData) {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(successData));
                return;
              }

              res.statusCode = lastStatus;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(lastErrData || { error: { message: 'Generation failed' } }));
            } catch (err: any) {
              console.error('API proxy error:', err);
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: { message: err.message || 'API Proxy Error' } }));
            }
          });
          return;
        }

        // Fast test key endpoint
        if (url === '/api/test-key' && req.method === 'POST') {
          let bodyStr = '';
          req.on('data', chunk => { bodyStr += chunk; });
          req.on('end', async () => {
            try {
              const body = JSON.parse(bodyStr || '{}');
              const key = getEffectiveKey(body.apiKey);
              if (!key) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: { message: 'No Gemini API key available in server environment.' } }));
                return;
              }
              const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${key}`;
              const testRes = await fetch(testUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: 'Respond with OK' }] }],
                  generationConfig: {
                    maxOutputTokens: 20,
                    thinkingConfig: { thinkingLevel: 'MINIMAL' }
                  }
                })
              });
              const testData = await testRes.json();
              res.statusCode = testRes.status;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(testData));
            } catch (err: any) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: { message: err.message } }));
            }
          });
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), aistudioMediaPlugin(), geminiApiPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
