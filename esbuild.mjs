import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: false,
  logLevel: 'info'
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log('正在监听扩展源码变化...');
} else {
  await esbuild.build(options);
}
