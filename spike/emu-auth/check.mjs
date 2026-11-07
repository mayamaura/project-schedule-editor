// EMU / GitHub のブラウザ認証（Git Credential Manager）の確認スクリプト（S0-4）。
// 使い方: node spike/emu-auth/check.mjs <利用するリポジトリの HTTPS URL>
//   例: node spike/emu-auth/check.mjs https://github.com/<組織>/<リポジトリ>.git
//       node spike/emu-auth/check.mjs https://<サブドメイン>.ghe.com/<組織>/<リポジトリ>.git
// 動作: git ls-remote を実行する。認証が必要ならブラウザが開く（GCM）。トークンは表示も保存もしない。
// 注意: 設定（git config）は一切変更しない。ghe.com の場合に必要な設定は、画面に案内を表示するだけ。
import { spawnSync } from 'node:child_process';

const url = process.argv[2];
if (!url || !/^https:\/\//.test(url)) {
  console.error('使い方: node spike/emu-auth/check.mjs https://<ホスト>/<組織>/<リポジトリ>.git');
  process.exit(2);
}
const host = new URL(url).host;
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const first = (r) => (r.stdout || r.stderr || '').trim().split('\n')[0] ?? '';

const gitVersion = first(run('git', ['--version']));
const gcm = run('git', ['credential-manager', '--version']);
const gcmVersion = gcm.status === 0 ? first(gcm).split('+')[0] : '（見つからない）';
const helper = (run('git', ['config', '--show-origin', '--get-all', 'credential.helper']).stdout || '').trim().replace(/\n/g, ' / ') || '（未設定）';
const hostProvider = (run('git', ['config', '--get', `credential.https://${host}.provider`]).stdout || '').trim() || '（未設定）';

console.log(`Git: ${gitVersion}\nGCM: ${gcmVersion}\ncredential.helper: ${helper}\ncredential.https://${host}.provider: ${hostProvider}`);
console.log(`\n接続先: ${host}\nls-remote を実行します。ブラウザが開いたらサインインしてください（最大5分待ちます）...\n`);

// GIT_TERMINAL_PROMPT=0 のみ設定（GCM_INTERACTIVE は設定しない = ブラウザ認証を許可）
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
const t0 = Date.now();
const r = run('git', ['ls-remote', '--heads', url], { env, timeout: 300000 });
const sec = ((Date.now() - t0) / 1000).toFixed(1);
const ok = r.status === 0;
const heads = ok ? (r.stdout || '').trim().split('\n').filter(Boolean).length : 0;
// エラー文からトークンらしき文字列を伏せる（念のため）
const err = (r.stderr || '').trim().split('\n').slice(-4).join(' | ').replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1***');

console.log(ok ? `✅ 成功: ブランチ ${heads} 件を取得（${sec} 秒）` : `❌ 失敗（${sec} 秒）: ${err}`);

console.log('\n--- 報告用（これを貼り付けてください。秘密情報は含まれません）---');
console.log(JSON.stringify({ host, git: gitVersion, gcm: gcmVersion, helper, hostProvider, result: ok ? 'ok' : 'failed', seconds: Number(sec), heads, error: ok ? null : err }, null, 2));

if (!ok) {
  console.log('\n--- 考えられる原因と対処 ---');
  if (host !== 'github.com') console.log(`・${host} は github.com ではありません。GCM に GitHub として扱わせる設定が必要な場合があります:\n    git config --global credential.https://${host}.provider github`);
  console.log('・ブラウザが開かない/サインインできない: 組織の SAML SSO や、OAuth App・GitHub App の承認ポリシーを管理者に確認してください。');
  console.log('・"repository not found": リポジトリ名・アクセス権、または SSO の承認（トークンの組織への承認）が未実施の可能性があります。');
  console.log('・"could not read Username": GCM が見つからない/無効です。Git for Windows の再インストール、または credential.helper の設定を確認してください。');
}
process.exit(ok ? 0 : 1);
