import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

// 直接用 esbuild 的 CLI 打包：不依赖 esbuild 的常驻 service 进程，
// 在受限沙箱里（禁止建立子进程管道）也能正常构建。
const esbuildCli = path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild');

const commonArgs = [
  '--bundle',
  '--target=chrome111',
  '--log-level=info',
  '--legal-comments=none',
  '--charset=utf8',
];

const targets = [
  { entry: 'src/page/main.ts', out: 'page.js', format: 'iife' },
  { entry: 'src/content/index.ts', out: 'content.js', format: 'iife' },
  { entry: 'src/content/styles.css', out: 'content.css' },
  { entry: 'src/background/sw.ts', out: 'background.js', format: 'esm' },
  { entry: 'src/options/options.ts', out: 'options.js', format: 'iife' },
  { entry: 'src/popup/popup.ts', out: 'popup.js', format: 'iife' },
];

function argsFor(target) {
  const args = [
    path.join(root, target.entry),
    `--outfile=${path.join(outdir, target.out)}`,
    ...commonArgs,
  ];
  if (target.format) args.push(`--format=${target.format}`);
  return args;
}

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp(path.join(root, 'public'), outdir, { recursive: true });

if (watch) {
  const children = targets.map((target) =>
    spawn(process.execPath, [esbuildCli, '--watch', ...argsFor(target)], {
      cwd: root,
      stdio: 'inherit',
    }),
  );
  const shutdown = () => {
    for (const child of children) child.kill();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.log('[yt-bilingual] watching for changes...');
} else {
  for (const target of targets) {
    execFileSync(process.execPath, [esbuildCli, ...argsFor(target)], {
      cwd: root,
      stdio: 'inherit',
    });
  }
  console.log(`[yt-bilingual] build complete -> ${outdir}`);
}
