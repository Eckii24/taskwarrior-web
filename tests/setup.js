const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'SVGElement', 'Document', 'ShadowRoot', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'getComputedStyle', 'localStorage', 'location', 'history']) globalThis[key] = dom.window[key];
globalThis.confirm = dom.window.confirm.bind(dom.window);
