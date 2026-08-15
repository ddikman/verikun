import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { dumpsAgree } from '../src/companion/dump-match';

/** A `<node …>` tag with only the attributes this comparison actually reads. */
function node(
  attrs: {
    id?: string;
    cls?: string;
    bounds?: string;
    clickable?: boolean;
    focusable?: boolean;
    longClickable?: boolean;
  } = {},
  leaf = true,
): string {
  const tag =
    `<node index="0" text="" resource-id="${attrs.id ?? ''}" ` +
    `class="${attrs.cls ?? 'android.view.View'}" ` +
    `clickable="${attrs.clickable ? 'true' : 'false'}" ` +
    `long-clickable="${attrs.longClickable ? 'true' : 'false'}" ` +
    `focusable="${attrs.focusable ? 'true' : 'false'}" ` +
    `bounds="${attrs.bounds ?? '[0,0][100,100]'}"`;
  return leaf ? `${tag} />` : `${tag}>`;
}

function hierarchy(body: string, rotation = 0): string {
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="${rotation}">${body}</hierarchy>`;
}

test('dumpsAgree: identical dumps agree — the fast path is unchanged', () => {
  const xml = hierarchy(`${node({ id: 'a' })}${node({ id: 'b', clickable: true })}`);
  assert.equal(dumpsAgree(xml, xml).agree, true);
});

test('dumpsAgree: trailing whitespace does not matter', () => {
  const xml = hierarchy(node({ id: 'a' }));
  assert.equal(dumpsAgree(`${xml}\n`, `  ${xml}  `).agree, true);
});

// THE CASE THIS EXISTS FOR (issue #79): the flagged companion drops one non-interactive
// leaf below the app window, and every other node stays byte-identical.
test('dumpsAgree: a missing non-interactive leaf is tolerated', () => {
  const app = node({ id: 'vk_submit', clickable: true, bounds: '[42,842][1038,968]' });
  const navBar = node({ id: 'android:id/navigationBarBackground', bounds: '[0,2274][1080,2400]' });
  const stock = hierarchy(`${app}${navBar}`);
  const companion = hierarchy(app);

  const m = dumpsAgree(stock, companion);
  assert.equal(m.agree, true, m.reason);
});

test('dumpsAgree: a missing CLICKABLE node is refused', () => {
  const keep = node({ id: 'a' });
  const gone = node({ id: 'vk_submit', clickable: true });
  const m = dumpsAgree(hierarchy(`${keep}${gone}`), hierarchy(keep));
  assert.equal(m.agree, false);
  assert.match(m.reason!, /tappable/);
});

test('dumpsAgree: a missing FOCUSABLE node is refused', () => {
  const keep = node({ id: 'a' });
  const gone = node({ id: 'vk_user', focusable: true });
  const m = dumpsAgree(hierarchy(`${keep}${gone}`), hierarchy(keep));
  assert.equal(m.agree, false);
  assert.match(m.reason!, /tappable/);
});

// `long-clickable="true"` contains the substring `clickable="true"`; reading it as
// interactive would be harmless, but reading a plain node as long-clickable would not.
test('dumpsAgree: long-clickable alone does not make a node tappable', () => {
  const keep = node({ id: 'a' });
  const gone = node({ id: 'decor', longClickable: true });
  assert.equal(dumpsAgree(hierarchy(`${keep}${gone}`), hierarchy(keep)).agree, true);
});

test('dumpsAgree: a missing CONTAINER is refused even when nothing about it is tappable', () => {
  const container = node({ id: 'wrap' }, false);
  const child = node({ id: 'a' });
  const stock = hierarchy(`${container}${child}</node>`);
  const m = dumpsAgree(stock, hierarchy(child));
  assert.equal(m.agree, false);
  assert.match(m.reason!, /container/);
});

// The tap-safety property, and the whole reason this is not just "ignore differences".
test('dumpsAgree: a node whose BOUNDS differ is never accepted', () => {
  const stock = hierarchy(node({ id: 'vk_submit', clickable: true, bounds: '[0,0][100,100]' }));
  const shifted = hierarchy(node({ id: 'vk_submit', clickable: true, bounds: '[0,0][100,90]' }));
  assert.equal(dumpsAgree(stock, shifted).agree, false);
});

test('dumpsAgree: the emulator "app" clip stays refused — every container moved', () => {
  // What the app-size clip really produces: same nodes, shorter bottoms.
  const tall = node({ id: 'content', focusable: true, bounds: '[0,0][1080,2274]' }, false);
  const short = node({ id: 'content', focusable: true, bounds: '[0,0][1080,2146]' }, false);
  const leaf = node({ id: 'a' });
  const m = dumpsAgree(hierarchy(`${tall}${leaf}</node>`), hierarchy(`${short}${leaf}</node>`));
  assert.equal(m.agree, false);
});

test('dumpsAgree: a companion node the platform never reported is refused', () => {
  const shared = node({ id: 'a' });
  const invented = node({ id: 'ghost' });
  const m = dumpsAgree(hierarchy(shared), hierarchy(`${shared}${invented}`));
  assert.equal(m.agree, false);
  assert.match(m.reason!, /does not/);
});

test('dumpsAgree: a rotation change is refused rather than reconciled', () => {
  const body = node({ id: 'a' });
  const m = dumpsAgree(hierarchy(body, 0), hierarchy(body, 1));
  assert.equal(m.agree, false);
  assert.match(m.reason!, /rotation/);
});

test('dumpsAgree: order matters — the same nodes rearranged do not agree', () => {
  const a = node({ id: 'a', clickable: true });
  const b = node({ id: 'b', clickable: true });
  assert.equal(dumpsAgree(hierarchy(`${a}${b}`), hierarchy(`${b}${a}`)).agree, false);
});
