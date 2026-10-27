/**
 * Loads the Baileys peer dependency once, under either package name.
 */
const BAILEYS_PACKAGES = ["baileys", "@whiskeysockets/baileys"];

let baileysModule: Promise<any> | null = null;

const importFirstAvailable = async (): Promise<any> => {
  for (const name of BAILEYS_PACKAGES) {
    try {
      return await import(name);
    } catch {}
  }
  throw new Error(`Could not import Baileys (${BAILEYS_PACKAGES.join(" or ")}). Install it as a peer dependency.`);
};

export const loadBaileys = (): Promise<any> => {
  baileysModule ??= importFirstAvailable();
  return baileysModule;
};
