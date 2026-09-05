# Successful replay fixture

`speed3.json` contains ordinary movement input recorded against the full game
engine on Speed 3. A waypoint controller used only left, right and jump for the
two characters. It changed no game state, time, physics or result fields.

The input stream reaches the first successful result at frame 265. The engine
derives node 12, medal 2 and 8 seconds. Test code builds the versioned canonical
replay and digest from this input, then checks that isolated worker execution
still produces the same outcome. A genuine rules change can require reviewing
this expectation. Never adjust result expectations merely to make a failing
replay pass.

This is a correctness fixture, not evidence of human play; verified rankings
establish rule compliance and cannot prove that the input was human-generated.
