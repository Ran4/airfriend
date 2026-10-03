// actors-game scenario: effects in the real game. Period 1 (camera looks +z,
// screen-right = world -x). Fires a bark, a knockdown, a hard stop and a goal.
const P = (x, z, f, st, sp = 0) => ({ x, z, f, st, sp });
const spots = [
  P(1.5, 19, -Math.PI / 2, 'skate', 6), // 0 dog skating screen-right
  P(-3.5, 17, Math.PI / 2, 'skate', 7), // 1 kid that hard-stops
  P(4.2, 22.0, 2.4, 'check'), // 2 hitter
  P(-6, 12, 0, 'skate'), // 3
  P(0, -25, 0, 'gReady'), // 4
  P(3.6, 21.6, -0.8, 'skate'), // 5 victim
  P(0.3, 20.0, Math.PI, 'skate'), // 6 startled by the bark
  P(-2.2, 23.4, Math.PI, 'celebrate'), // 7
  P(2.0, 15, Math.PI, 'skate'), // 8
  P(0.0, 25.8, Math.PI, 'gReady'), // 9 goalie
];
const fired = new Set();
const once = (t, at) => (t >= at && !fired.has(at) ? (fired.add(at), true) : false);
function tick(st, t) {
  st.phase = 'play';
  st.skaters.forEach((s, i) => {
    const o = spots[i];
    if (i === 0 || i === 1) {
      if (t < 0.02) {
        s.pos.x = o.x;
        s.pos.z = o.z;
      }
    } else {
      s.pos.x = o.x;
      s.pos.z = o.z;
    }
    s.facing = o.f;
    const sp = i === 1 && t > 0.6 ? 0 : o.sp;
    s.vel.x = Math.sin(o.f) * sp;
    s.vel.z = Math.cos(o.f) * sp;
    if (!(i === 5 && t > 0.8)) s.state = o.st;
    s.invuln = 0;
  });
  if (t > 0.8) st.skaters[5].state = 'fallen';
  st.controlledId = 0;
  st.puck.owner = null;
  st.puck.pos.x = 0.3;
  st.puck.pos.z = 26.8;
  st.puck.vel.x = 0;
  st.puck.vel.z = 0;
  if (once(t, 0.4)) emit({ type: 'bark', skaterId: 0, startled: [6] });
  if (once(t, 0.6)) emit({ type: 'hardStop', skaterId: 1, speed: 7 });
  if (once(t, 0.8)) emit({ type: 'check', hitter: 2, victim: 5, force: 8, knockedDown: true });
  if (once(t, 1.0)) emit({ type: 'goal', info: { team: 0, scorer: 0, assists: [], period: 1, clock: 90, powerPlay: false, shortHanded: false } });
}
