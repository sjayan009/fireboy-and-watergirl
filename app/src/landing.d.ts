/** The landing page's behaviour, written as a plain ES module in design/landing. */
declare module "@landing/shared/landing.js" {
  export function mountLanding(
    root: ParentNode & EventTarget,
    options?: { autoplay?: boolean },
  ): { destroy(): void; scene: unknown; journey: unknown; watch: unknown };
}
