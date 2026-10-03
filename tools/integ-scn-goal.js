// integ scenario: hold the 'goal' phase with the puck in a net, to check the
// celebration framing at either end. end=near (HOME's net) or end=far.
const q = new URLSearchParams(location.search);
const far = q.get('end') === 'far';
function tick(st, t) {
  st.phase = 'goal';
  st.phaseTime = 1.5;
  st.period = 1;
  const z = far ? 27.0 : -27.0;
  st.puck.owner = null;
  st.puck.pos.x = 0.3; st.puck.pos.z = z; st.puck.vel.x = st.puck.vel.z = 0; st.puck.y = 0;
}
