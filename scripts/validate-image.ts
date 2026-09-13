import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function runCommand(command: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-32_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} exceeded ${timeout}ms. ${output}`));
    }, timeout);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${command} exited with ${code}. ${output}`));
    });
  });
}

export async function validateImage(image: string, pull = true, copiedVolume?: string): Promise<void> {
  if (pull && !/@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error('--image must name an immutable repository@sha256:digest');
  }
  if (pull) await runCommand('docker', ['pull', image], 300_000);
  if (copiedVolume) {
    await validateCopiedVolume(image, copiedVolume);
    return;
  }
  const container = `tweets-2-bsky-validation-${process.pid}-${Date.now()}`;
  try {
    await runCommand('docker', [
      'run',
      '--detach',
      '--name',
      container,
      '--publish',
      '127.0.0.1::3000',
      '--env',
      'JWT_SECRET=release-validation-only-not-a-production-secret',
      '--env',
      `CONFIG_ENCRYPTION_KEY=${'33'.repeat(32)}`,
      image,
    ]);
    const ports = JSON.parse(
      await runCommand('docker', ['inspect', '--format={{json .NetworkSettings.Ports}}', container]),
    ) as Record<string, Array<{ HostPort: string }>>;
    const port = ports['3000/tcp']?.[0]?.HostPort;
    if (!port) throw new Error('Docker did not allocate the validation HTTP port');
    const deadline = Date.now() + 180_000;
    let ready = false;
    while (Date.now() < deadline) {
      const health = await runCommand('docker', ['inspect', '--format={{.State.Health.Status}}', container]);
      if (health === 'unhealthy') throw new Error('Validation container became unhealthy');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(5_000) });
        const payload = (await response.json()) as { status?: string };
        if (response.ok && payload.status === 'ready' && health === 'healthy') {
          ready = true;
          break;
        }
      } catch {
        // Startup may not have opened the published socket yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (!ready) throw new Error('Validation container readiness exceeded 180 seconds');
    console.log(await runCommand('docker', ['exec', container, 'bun', '/app/scripts/image-runtime-smoke.ts'], 90_000));
    await validateImageData(image);
    console.log(`Published image readiness and runtime smoke passed: ${image}`);
  } catch (error) {
    const logs = await runCommand('docker', ['logs', '--tail', '80', container]).catch(
      () => 'No container logs available',
    );
    throw new Error(`Image validation failed. ${logs}`, { cause: error });
  } finally {
    // Only this uniquely named, fresh fixture container and its anonymous volume.
    await runCommand('docker', ['rm', '--force', '--volumes', container]).catch(() => undefined);
  }
}

async function validateCopiedVolume(image: string, sourcePath: string): Promise<void> {
  const source = fs.realpathSync(path.resolve(sourcePath));
  if (!fs.statSync(source).isDirectory()) throw new Error('--copied-volume must be a protected snapshot directory');
  if (source.includes(',')) throw new Error('Snapshot directory may not contain commas');
  const volume = `tweets-2-bsky-protected-copy-${process.pid}-${Date.now()}`;
  await runCommand('docker', ['volume', 'create', volume]);
  try {
    for (const stage of ['copy', 'migrate', 'restart']) {
      const args = [
        'run',
        '--name',
        `${volume}-${stage}`,
        '--network',
        'none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--tmpfs=/tmp:rw,nosuid,size=128m',
        '--mount',
        `type=volume,source=${volume},target=/app/data`,
        '--env',
        'CONFIG_ENCRYPTION_KEY',
        '--entrypoint',
        'bun',
      ];
      if (stage === 'copy') args.push('--mount', `type=bind,source=${source},target=/snapshot-input,readonly`);
      args.push(image, '/app/scripts/image-copied-volume-smoke.ts', stage);
      try {
        console.log(await runCommand('docker', args, 180_000));
      } catch {
        // Docker may include mount paths in errors. Do not surface the captured
        // output for a protected copy, and never request container logs here.
        throw new Error(
          `Protected copied-volume ${stage} failed; source was mounted read-only and diagnostics withheld`,
        );
      } finally {
        await runCommand('docker', ['rm', '--force', '--volumes', `${volume}-${stage}`]).catch(() => undefined);
      }
    }
    console.log(
      'Protected copied-volume migration, backup validation and restart continuity passed without starting the application.',
    );
  } finally {
    await runCommand('docker', ['volume', 'rm', volume]);
  }
}

async function validateImageData(image: string): Promise<void> {
  for (const fixture of [
    'config-v0-single-source.json',
    'config-v1-multi-source.json',
    'config-v6-current.json',
    'config-v6-populated.json',
    'config-v7-current.json',
    'config-v8-current.json',
  ]) {
    const volume = `tweets-2-bsky-fixture-${process.pid}-${Date.now()}`;
    await runCommand('docker', ['volume', 'create', volume]);
    try {
      for (const stage of ['seed', 'restart', 'restored']) {
        console.log(
          await runCommand(
            'docker',
            [
              'run',
              '--rm',
              '--name',
              `${volume}-${stage}`,
              '--network',
              'none',
              '--mount',
              `type=volume,source=${volume},target=/app/data`,
              '--env',
              `CONFIG_ENCRYPTION_KEY=${'33'.repeat(32)}`,
              '--entrypoint',
              'bun',
              image,
              '/app/scripts/image-data-smoke.ts',
              stage,
              fixture,
            ],
            90_000,
          ),
        );
      }
    } finally {
      for (const stage of ['seed', 'restart', 'restored']) {
        await runCommand('docker', ['rm', '--force', '--volumes', `${volume}-${stage}`]).catch(() => undefined);
      }
      // This name is created above for one isolated fixture, never a deployment volume.
      await runCommand('docker', ['volume', 'rm', volume]);
    }
  }
}

if (import.meta.main) {
  const imageFlag = process.argv.indexOf('--image');
  const image = imageFlag >= 0 ? process.argv[imageFlag + 1] : undefined;
  if (!image) throw new Error('Usage: bun scripts/validate-image.ts --image repository@sha256:digest');
  const copyFlag = process.argv.indexOf('--copied-volume');
  const copyPath = copyFlag >= 0 ? process.argv[copyFlag + 1] : undefined;
  if (copyFlag >= 0 && !copyPath) throw new Error('--copied-volume requires a protected snapshot directory');
  await validateImage(image, true, copyPath);
}
