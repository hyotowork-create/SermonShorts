// macOS 배포 기준 점검(서명·공증 뒤, dmg에 담기기 전). 못 맞추면 빌드를 멈춰 깨진 앱이 릴리스되지 않게 한다.
// 1단계(항상): 서명이 유효해야 함 → 「손상된 앱」이 나오지 않음
// 2단계(공증 정보가 있을 때): Gatekeeper 통과 + 공증 표가 붙어 있어야 함 → 경고 없이 바로 열림
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function macVerify(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
  if (process.env.CSC_LINK && process.env.APPLE_TEAM_ID) {
    execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose', app], { stdio: 'inherit' });
    execFileSync('xcrun', ['stapler', 'validate', app], { stdio: 'inherit' });
    console.log('  • 배포 기준 2단계 통과(서명·공증·Gatekeeper)');
  } else {
    console.log('  • 배포 기준 1단계 통과(ad-hoc 서명 유효). 인증서·공증 정보가 없어 첫 실행 시 「그래도 열기」 필요');
  }
};
