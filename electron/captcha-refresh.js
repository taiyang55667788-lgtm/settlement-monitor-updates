const SELECT_IMAGE = `const images = [...document.images];
  const sized = img => { const r = img.getBoundingClientRect(); return r.width >= 45 && r.width <= 220 && r.height >= 18 && r.height <= 80; };
  const image = images.find(img => sized(img) && /captcha|verify|checkcode|validcode/i.test([img.src,img.id,img.className,img.alt].join(' ')))
    || images.find(img => sized(img) && /验证码/.test(img.closest('li, tr, div')?.innerText || '')) || images.find(sized);`;

function captchaImageScript(click = false) {
  return `(() => { ${SELECT_IMAGE}
    if (!image) return null;
    ${click ? 'image.click(); return true;' : `const r = image.getBoundingClientRect();
    return { ready: image.complete && image.naturalWidth > 0 && image.naturalHeight > 0,
      rect: { x: Math.max(0,Math.floor(r.x)), y: Math.max(0,Math.floor(r.y)), width: Math.ceil(r.width), height: Math.ceil(r.height) } };`}
  })()`;
}

async function refreshLoadedCaptcha({ snapshot, click, wait, cancelled = () => false, attempts = 3, polls = 8 }) {
  const before = await snapshot();
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (cancelled()) throw Object.assign(new Error('读取已中断'), { code: 'READ_INTERRUPTED' });
    await click();
    for (let poll = 0; poll < polls; poll++) {
      await wait(350);
      if (cancelled()) throw Object.assign(new Error('读取已中断'), { code: 'READ_INTERRUPTED' });
      const current = await snapshot();
      if (current?.ready && current.fingerprint && (!before?.ready || current.fingerprint !== before.fingerprint)) return current;
    }
  }
  throw Object.assign(new Error('验证码图片刷新加载超时，未提交旧图；等待网络恢复后重试'), { code: 'CAPTCHA_IMAGE_LOAD_TIMEOUT' });
}

module.exports = { captchaImageScript, refreshLoadedCaptcha };
