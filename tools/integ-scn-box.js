// integ scenario: PAL and BUTCH both sitting in their penalty boxes (+x side)
// while JOSH carries the puck up the near boards, so the camera's side margin
// should keep both boxes in frame. per=2 flips the camera.
const per = Number(new URLSearchParams(location.search).get('per') || 1);
const d = per === 2 ? -1 : 1;
function tick(st, t) {
  st.phase = 'play';
  st.period = per;
  st.clock = 100;
  const park = (id, x, z) => {
    const s = st.skaters[id];
    s.state = 'box';
    s.pos.x = x; s.pos.z = z; s.vel.x = s.vel.z = 0;
    s.facing = -Math.PI / 2; // facing the ice
  };
  park(0, 14.6, -4.6);
  park(7, 14.6, 3.4);
  st.controlledId = 1;
  const j = st.skaters[1];
  j.state = 'skate';
  j.pos.x = 10.5; j.pos.z = d * (-6 + ((t * 3) % 12));
  j.vel.x = 0; j.vel.z = 3 * d; j.facing = d > 0 ? 0 : Math.PI;
  st.puck.owner = 1;
}
