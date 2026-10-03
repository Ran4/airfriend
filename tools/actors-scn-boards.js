// actors-game scenario: skaters parked around the far net and along the boards
// (period 1: camera looks +z, screen-right = world -x).
const spots = [
  [-12.35, 21.0, 0, 'skate'], // 0 dog hugging the screen-right boards, skating up
  [12.3, 22.0, Math.PI / 2, 'skate'], // 1 kid at screen-left boards facing into them
  [-4.0, 27.6, Math.PI, 'skate'], // 2 kid behind the goal line, screen-right of the net
  [2.5, 18.5, 0.6, 'fallen'], // 3 fallen in the slot
  [0.0, -20, 0, 'skate'], // 4 home goalie (off screen)
  [0.2, 28.3, Math.PI, 'skate'], // 5 away kid directly behind the net
  [-0.6, 24.2, Math.PI, 'skate'], // 6 away kid in front of the crease
  [8.5, 29.3, -Math.PI / 2, 'skate'], // 7 away kid in the far corner by the end boards
  [-2.0, 20.5, Math.PI, 'celebrate'], // 8 away kid celebrating
  [0.0, 25.7, Math.PI, 'gReady'], // 9 away goalie in the crease
];
function tick(st) {
  st.phase = 'play';
  st.skaters.forEach((s, i) => {
    const [x, z, f, state] = spots[i];
    s.pos.x = x;
    s.pos.z = z;
    s.facing = f;
    const sp = i === 0 ? 4 : 0;
    s.vel.x = Math.sin(f) * sp;
    s.vel.z = Math.cos(f) * sp;
    s.state = state;
  });
  st.puck.owner = null;
  st.puck.pos.x = -1.2;
  st.puck.pos.z = 22.5;
  st.puck.vel.x = 0;
  st.puck.vel.z = 0;
  st.referee.pos.x = 5;
  st.referee.pos.z = 19;
}
