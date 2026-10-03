// integ scenario: 8 skaters in a screen-space row (left -> right), each moving
// in a known SCREEN direction. Every second the directions rotate by one step,
// so the dog cycles through all 8. Slot k moves toward dirs[(k + step) % 8]:
// N NE E SE S SW W NW (screen). Add `per=2` to --params for the flipped camera.
const per = Number(new URLSearchParams(location.search).get('per') || 1);
const d = per === 2 ? -1 : 1; // attackDir(home, period)
const slots = [0, 1, 2, 3, 5, 6, 7, 8]; // dog first, goalies parked
function setup(api) {
  api.state.period = per;
}
function tick(st, t) {
  st.phase = 'play';
  st.period = per;
  st.clock = 100;
  const step = Math.floor(t / 1.0);
  slots.forEach((id, k) => {
    const s = st.skaters[id];
    const a = (((k + step) % 8) * Math.PI) / 4; // screen angle, 0 = up, +PI/2 = right
    const xs = Math.sin(a), ys = Math.cos(a);
    // camera right = world (-d, 0), camera forward = world (0, d)
    const wx = -d * xs, wz = d * ys;
    // screen column k: screen x grows to the right => world x = -d * sx
    const sx = (k - 3.5) * 2.2;
    s.pos.x = -d * sx;
    s.pos.z = d * (k % 2 ? 1.2 : -1.2);
    s.vel.x = wx * 5;
    s.vel.z = wz * 5;
    s.facing = Math.atan2(wx, wz);
    s.state = 'skate';
    s.intent.move = { x: wx, z: wz };
  });
  for (const g of [4, 9]) { st.skaters[g].pos.x = 0; st.skaters[g].pos.z = (g === 4 ? -25 : 25) * d; }
  st.puck.owner = null;
  st.puck.pos.x = 0; st.puck.pos.z = 4 * d; st.puck.vel.x = st.puck.vel.z = 0; st.puck.y = 0;
  st.referee.pos.x = 0; st.referee.pos.z = 5 * d;
}
