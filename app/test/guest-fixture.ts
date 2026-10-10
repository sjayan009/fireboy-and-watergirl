// The play screen with no account; absent from the production build.
//
// Deliberately nothing patched, unlike play-fixture.ts: the real Supabase
// client, signed out, so anything in guest mode that reached for the server
// would be a real request that play-guest.mjs sees and counts.
import "../src/ui/styles.css";
import { playScreen } from "../src/screens/play.js";

Object.assign(window, { fixtureSupabaseUrl: __SUPABASE_URL__ });
playScreen(document.getElementById("app")!, { guest: true });
