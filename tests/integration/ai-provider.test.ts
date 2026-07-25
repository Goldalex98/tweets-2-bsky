import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

test('AI provider tests are injectable, bounded, and purpose isolated', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'ai.json');
  const moduleUrl = new URL('../../src/ai-manager.ts', import.meta.url).href;
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const ai = await import(${JSON.stringify(moduleUrl)});
          const textCapabilities = Object.fromEntries(
            ['translation', 'summarization', 'cleanup', 'hashtags'].map((purpose) => [
              purpose, { enabled: false, purpose, privacyDescription: 'test privacy' },
            ]),
          );
          const config = {
            enabled: true,
            purpose: 'image-alt-text',
            provider: 'custom',
            baseUrl: 'https://provider.invalid/v1',
            maxAltTextChars: 12,
            privacyDescription: 'test privacy',
            textCapabilities,
          };
          const requests = [];
          const usage = [];
          const client = {
            async complete(request) {
              requests.push({
                purpose: request.purpose,
                hasImage: Boolean(request.image),
                imageBytes: request.image?.buffer.length,
              });
              return 'A generated transparent test image';
            },
          };
          const tested = await ai.testAIProvider({
            config,
            client,
            recordUsage: (entry) => usage.push(entry),
          });
          const alt = await ai.generateAltText(
            Buffer.from('not-real-user-media'),
            'image/png',
            'context',
            { config, client },
          );
          const translationResolved = ai.resolveAiProvider(config, undefined, 'translation');
          await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
            tested, alt, translationResolved, requests, usage,
          }));
        `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as any;
    expect(result.tested).toMatchObject({
      success: true,
      testPayload: 'generated-1x1-transparent-png',
    });
    expect(result.requests[0]).toMatchObject({ purpose: 'provider-test', hasImage: true, imageBytes: 68 });
    expect(result.alt.length).toBeLessThanOrEqual(12);
    expect(result.translationResolved).toBeNull();
    expect(result.usage.map((entry: any) => entry.status)).toEqual(['request', 'success']);
  } finally {
    temporary.cleanup();
  }
});
