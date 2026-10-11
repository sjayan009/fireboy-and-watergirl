/**
 * Everything the play screen uses only with an account, as one module.
 *
 * The lobby and its networking, friends, Quick Match, the leaderboard, the
 * match lease, sharing and watching, Settings -- and through them the Supabase
 * client. A guest constructs none of it (see the guest note in play.ts), so it
 * is not imported by play.ts at all: main.ts imports this, beside the screen,
 * only when somebody is signed in, and hands it to `playScreen`. Both downloads
 * start together, so a player waits for the slower of the two rather than for
 * one after the other -- the same as when this was all one static graph.
 */
export { getLobby } from "./lobby.js";
export { FriendsPanel } from "./screens/friends.js";
export { settingsScreen } from "./screens/settings.js";
export { Leaderboard } from "./ui/leaderboard.js";
export { QuickCard } from "./ui/quickcard.js";
export { leaderboardCache } from "./ranking.js";
export { MatchLease } from "./matchlease.js";
export { MatchSharing } from "./sharing.js";
export { WatchChannel } from "./net/watchchannel.js";
export { WatchMirror } from "./net/watch.js";
export { endMatch, findPartner, touchMatch, TOUCH_MS } from "./quickmatch.js";
export { block as blockPlayer, request as requestFriend } from "./friends.js";
