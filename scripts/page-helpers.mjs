/**
 * In-page helpers injected once, then called by the CDP driver.
 * Keeping them in a plain string avoids nested-template escaping bugs.
 */
export const PAGE_HELPERS = `
window.__probe = {
  ringInfo() {
    const btn = document.querySelector('button[aria-label="回到顶部"]');
    if (!btn) return { found: false };
    const circles = [...btn.querySelectorAll('circle')];
    const arc = circles[1];
    if (!arc) return { found: true, arc: false };
    return {
      found: true,
      arc: true,
      dashArray: arc.getAttribute('stroke-dasharray'),
      dashOffsetAttr: arc.getAttribute('stroke-dashoffset'),
      dashOffsetStyle: arc.style.strokeDashoffset,
      strokeWidth: arc.getAttribute('stroke-width'),
      r: arc.getAttribute('r'),
      hasGradient: (arc.getAttribute('stroke') || '').startsWith('url('),
    };
  },

  readRing() {
    const btn = document.querySelector('button[aria-label="回到顶部"]');
    const arc = btn ? btn.querySelectorAll('circle')[1] : null;
    const label = btn ? btn.querySelector('span') : null;
    return {
      offsetStyle: arc ? arc.style.strokeDashoffset : null,
      offsetAttr: arc ? arc.getAttribute('stroke-dashoffset') : null,
      label: label ? label.textContent : null,
    };
  },

  readMouseHud() {
    const t = document.body.innerText;
    const m = t.match(/([-]?\\d+\\.\\d+) \\/ ([-]?\\d+\\.\\d+)/);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : { raw: t.slice(0, 160) };
  },

  enableHud() {
    const b = [...document.querySelectorAll('button[aria-label]')]
      .find(x => (x.getAttribute('aria-label') || '').includes('FPS'));
    if (b && (b.getAttribute('aria-label') || '').includes('开启')) b.click();
    return true;
  },

  mkTouch(type, pts) {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    const make = p => new Touch({ identifier: p.id ?? 1, target: document.body, clientX: p.x, clientY: p.y });
    const list = pts.map(make);
    Object.defineProperty(ev, 'touches', { value: type === 'touchend' || type === 'touchcancel' ? [] : list });
    Object.defineProperty(ev, 'changedTouches', { value: list });
    Object.defineProperty(ev, 'targetTouches', { value: type === 'touchend' || type === 'touchcancel' ? [] : list });
    return ev;
  },

  touchAt(x, y) {
    window.__probe.dispatch('touchstart', [{ x, y }]);
    window.__probe.dispatch('touchmove', [{ x, y }]);
    return true;
  },

  touchMove(x, y) {
    window.__probe.dispatch('touchmove', [{ x, y }]);
    return true;
  },

  touchEnd(x, y) {
    window.__probe.dispatch('touchend', [{ x, y }]);
    return true;
  },

  pinchAt(a, b) {
    window.__probe.dispatch('touchmove', [a, b]);
    return true;
  },

  dispatch(type, pts) {
    window.dispatchEvent(window.__probe.mkTouch(type, pts));
    return true;
  },

  async countRingMutations() {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const btn = document.querySelector('button[aria-label="回到顶部"]');
    const arc = btn.querySelectorAll('circle')[1];
    const label = btn.querySelector('span');

    let styleWrites = 0;
    let textWrites = 0;
    const obs = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === 'attributes') styleWrites++;
        if (m.type === 'childList' || m.type === 'characterData') textWrites++;
      }
    });
    obs.observe(arc, { attributes: true, attributeFilter: ['style', 'stroke-dashoffset'] });
    obs.observe(label, { childList: true, characterData: true, subtree: true });

    const total = document.body.scrollHeight - window.innerHeight;
    for (let i = 0; i <= 40; i++) {
      window.scrollTo(0, (total * i) / 40);
      await wait(45);
    }
    await wait(350);
    obs.disconnect();
    return { styleWrites, textWrites, labelChildNodes: label.childNodes.length };
  }
};
`

/** Seeds a controlled scroll position and resolves after Lenis settles. */
export const scrollTo = (fraction) => `
(() => {
  const total = document.body.scrollHeight - window.innerHeight;
  window.scrollTo(0, total * ${fraction});
  return new Promise(r => setTimeout(r, 1400));
})()
`
