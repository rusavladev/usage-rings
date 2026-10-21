// Builds the standalone "Usage Rings" app into ./dist for the current OS (or --platform / --arch).
//   npm run pack
//   npm run pack -- --platform=darwin --arch=arm64
const path = require('path');
const { execFileSync } = require('child_process');
const { packager } = require('@electron/packager');

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};

const platform = arg('platform', process.platform);
const arch = arg('arch', process.arch);
const root = path.join(__dirname, '..');

const opts = {
  dir: root,
  name: 'Usage Rings',
  out: path.join(root, 'dist'),
  overwrite: true,
  prune: true,
  platform,
  arch,
  ignore: [/^\/(docs|test|scripts|dist|smoke-out|\.github|\.git)(\/|$)/, /^\/\.gitignore$/, /^\/package-lock\.json$/],
  appBundleId: 'dev.usagerings.app',
  appCategoryType: 'public.app-category.utilities',
  appCopyright: 'MIT License',
  icon: path.join(root, 'assets', platform === 'darwin' ? 'icon.icns' : 'icon.ico'),
  extendInfo: path.join(root, 'assets', 'mac-extra-info.plist'), // LSUIElement: menu-bar app, no Dock icon
  win32metadata: {
    ProductName: 'Usage Rings',
    FileDescription: 'Usage Rings',
    InternalName: 'Usage Rings',
    OriginalFilename: 'Usage Rings.exe',
  },
};

(async () => {
  const dirs = await packager(opts);
  for (const d of dirs) {
    console.log('built', d);
    if (platform === 'darwin' && process.platform === 'darwin') {
      // Ad-hoc signature: required for the app to launch on Apple Silicon (no Apple developer account needed).
      const app = path.join(d, 'Usage Rings.app');
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
      console.log('ad-hoc signed', app);
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
