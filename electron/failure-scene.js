const DAYS = 7 * 86400000;
const TITLES = ['login', 'report', 'error', 'other', 'empty'];
const HINTS = ['other-login', 'session-expired', 'credentials-rejected', 'captcha-rejected', 'access-denied', 'service-error', 'network-error'];
const SCRIPT = `(() => {
  const body = (document.body?.innerText || '').slice(0, 20000);
  const title = document.title || '';
  const hints = [];
  for (const [key, pattern] of [
    ['other-login', /其他地方登录|异地登录|别处登录|其他设备登录/],
    ['session-expired', /登录已过期|登录状态已失效|会话.*失效|登录超时|登录已超时|长时间未操作/],
    ['credentials-rejected', /密码错误|账号不存在|用户名.*错误|密码不正确/],
    ['captcha-rejected', /验证码错误|验证码不正确|验证码已过期/],
    ['access-denied', /访问被拒绝|禁止访问|Access Denied|Forbidden/i],
    ['service-error', /服务器错误|系统繁忙|服务不可用|Bad Gateway|Service Unavailable/i],
    ['network-error', /无法访问此网站|连接已重置|连接超时|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED/i]
  ]) if (pattern.test(body)) hints.push(key);
  return {
    title: !title ? 'empty' : /登录|登陆|login/i.test(title) ? 'login' : /报表|report/i.test(title) ? 'report' : /错误|error/i.test(title) ? 'error' : 'other',
    document: !body.trim() ? 'blank' : document.querySelector('input[type="password"]') ? 'login-form' : /报表查询/.test(body) ? 'report-menu' : 'other',
    hints
  };
})()`;

function safeLocation(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return 'non-web-page';
    const paths = ['/', '/Member/Login', '/Home/Index', '/IntimeSheet/Index'];
    const path = paths.find(path => path.toLowerCase() === url.pathname.toLowerCase());
    return url.origin + (path || '/[path-hidden]');
  } catch { return 'unavailable'; }
}

function retainedScenes(scenes = [], now = Date.now()) {
  return (Array.isArray(scenes) ? scenes : []).filter(scene => scene && now - Date.parse(scene.at) >= 0 && now - Date.parse(scene.at) < DAYS)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 10).map(scene => ({
      at: new Date(scene.at).toISOString(), location: safeLocation(scene.location), loading: typeof scene.loading === 'boolean' ? scene.loading : null,
      title: TITLES.includes(scene.title) ? scene.title : 'other',
      document: ['blank', 'login-form', 'report-menu', 'other'].includes(scene.document) ? scene.document : 'other',
      hints: Array.from(Array.isArray(scene.hints) ? scene.hints : []).filter(hint => HINTS.includes(hint)).slice(0, HINTS.length),
      capture: ['ok', 'timeout', 'unavailable'].includes(scene.capture) ? scene.capture : 'unavailable',
      phase: ['before-rebuild', 'before-navigation'].includes(scene.phase) ? scene.phase : 'failure',
    }));
}

async function captureFailureScene(win, { phase = 'failure', timeoutMs = 750 } = {}) {
  const scene = { at: new Date().toISOString(), location: 'unavailable', loading: null, capture: 'unavailable', phase };
  let timer;
  try {
    if (!win || win.isDestroyed?.()) return retainedScenes([scene])[0];
    const contents = win.webContents;
    scene.location = safeLocation(contents.getURL());
    scene.loading = Boolean(contents.isLoading?.());
    const frame = contents.mainFrame || contents;
    const result = await Promise.race([
      frame.executeJavaScript(SCRIPT, true),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    if (result && typeof result === 'object') {
      scene.title = result.title; scene.document = result.document; scene.hints = result.hints;
      scene.capture = 'ok';
    } else scene.capture = 'timeout';
  } catch {} finally { clearTimeout(timer); }
  return retainedScenes([scene])[0];
}

function sceneLoginReason(scene) {
  if (scene?.hints?.includes('other-login')) return '网站页面明确提示其他地方或设备登录';
  if (scene?.hints?.includes('session-expired')) return '网站页面明确提示登录超时或会话失效';
  return '';
}

module.exports = { captureFailureScene, retainedScenes, safeLocation, sceneLoginReason };
