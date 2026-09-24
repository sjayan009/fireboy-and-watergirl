/** Editor/CI type bridge; the deployed runtime provides Deno and npm imports. */
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};
declare module "npm:@supabase/supabase-js@2.112.4" {
  export { createClient } from "@supabase/supabase-js";
}
