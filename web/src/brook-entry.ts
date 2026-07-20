// Self-hosted brookmd browser bundle entry for isobox chatbot.
//
// Importing this module:
//   - registers the <brook-markdown> custom element (light DOM),
//   - re-exports BrookClient + defineBrookMarkdown as ESM named exports,
//   - mirrors both onto window (window.BrookClient / window.defineBrookMarkdown)
//     so a plain <script type="module"> page can use them without bundling.
//
// The brookmd styles are imported so Vite emits a co-located CSS asset; the
// page should also <link> it (see report) for polished, themed markdown.
import { defineBrookMarkdown } from "brookmd/element";
import { BrookClient } from "brookmd/client";
import "brookmd/styles.css";

// Auto-register on import so consumers just need <brook-markdown> in the DOM.
defineBrookMarkdown();

declare global {
  interface Window {
    BrookClient: typeof BrookClient;
    defineBrookMarkdown: typeof defineBrookMarkdown;
  }
}

if (typeof window !== "undefined") {
  window.BrookClient = BrookClient;
  window.defineBrookMarkdown = defineBrookMarkdown;
}

export { BrookClient, defineBrookMarkdown };
