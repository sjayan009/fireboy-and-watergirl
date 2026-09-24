import { supabase } from "../supabase.js";
import { createRuntimeIceLoader } from "./turn-loader.js";

const loader = createRuntimeIceLoader(async () => {
  const result = await supabase.functions.invoke("turn-credentials", { timeout: 4000 });
  return { data: result.data as unknown, error: result.error };
});

let account: string | null = null;
supabase.auth.onAuthStateChange((event, session) => {
  const next = session?.user.id ?? null;
  if (event === "SIGNED_OUT" || next !== account) loader.clear();
  account = next;
});

export const runtimeIceServers = (fallback: RTCIceServer[], options?: { forceRefresh?: boolean }) => loader.load(fallback, options);
/** Future refresh/ICE restart integration can invalidate without reloading. */
export const clearRuntimeIceServers = () => loader.clear();
