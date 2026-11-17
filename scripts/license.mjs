#!/usr/bin/env node
/**
 * Outil du propriétaire pour les licences Stockly Pro (NON inclus dans l'application).
 *
 *   pnpm license:keygen [--out chemin] [--force]
 *       Crée la clé privée (à garder secrète, hors du dépôt) et affiche la clé
 *       publique à coller dans app.json > expo.extra.licensePublicKey.
 *
 *   pnpm license:issue --company "Société" --phone XXXX-XXXX-XXXX-XXXX --expires AAAA-MM-JJ
 *                      [--key chemin] [--serial ID]
 *
 * Emplacement par défaut de la clé privée : ~/.stockly/stockly-license-private.key
 * (hors du projet, pour ne pas la perdre avec une copie de travail ni l'envoyer
 * dans un build), ou la variable d'environnement STOCKLY_LICENSE_KEY.
 *       Affiche le code d'activation à envoyer au client (valable jusqu'au jour
 *       --expires inclus, pour ce téléphone uniquement).
 *
 * Le format et la signature sont définis dans data/licenseCode.ts, importé
 * directement (Node ≥ 22.18 retire les types TypeScript à l'import) : l'outil
 * et l'application partagent exactement le même code.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_KEY_FILE = process.env.STOCKLY_LICENSE_KEY || join(homedir(), '.stockly', 'stockly-license-private.key');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`Node ${process.versions.node} : Node 22.18 ou plus récent est requis (import direct de data/licenseCode.ts).`);
  process.exit(1);
}

const L = await import('../data/licenseCode.ts');

/** Crée la clé privée dans `out` ; renvoie la clé publique. */
export function keygen(out = DEFAULT_KEY_FILE, { force = false } = {}) {
  const path = resolve(out);
  const seed = randomBytes(32);
  const content = L.formatPrivateKeyFile(seed);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!force) {
    // Création exclusive : deux keygen simultanés ne peuvent pas s'écraser.
    try {
      writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        throw new Error(`${path} existe déjà : utilisez --force pour l'écraser (les codes déjà émis deviendraient invalides avec la nouvelle clé publique).`);
      }
      throw e;
    }
  } else {
    // --force : nouveau fichier temporaire créé en 0600, puis remplacement atomique
    // (le mode d'un fichier existant, par ex. 0644, n'est pas conservé).
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }
  return { path, publicKey: L.keyPairFromSeed(seed).publicKey };
}

export function readSeed(keyPath = DEFAULT_KEY_FILE) {
  const path = resolve(keyPath);
  if (!existsSync(path)) throw new Error(`Clé privée introuvable : ${path} (créez-la avec « pnpm license:keygen »).`);
  const seed = L.parsePrivateKeyFile(readFileSync(path, 'utf8'));
  if (!seed) throw new Error(`Fichier de clé privée invalide : ${path}`);
  return seed;
}

/** Numéro de licence aléatoire (8 caractères Crockford). */
export function newSerial() {
  const b = randomBytes(8);
  return Array.from(b, (x) => L.CROCKFORD_ALPHABET[x & 31]).join('');
}

/** Émet un code d'activation. */
export function issue({ company, phone, expires, serial = newSerial(), key = DEFAULT_KEY_FILE }) {
  return L.issueActivationCode({ company, phone, expires, serial }, readSeed(key));
}

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[a.slice(2)] = argv[++i];
      else opts[a.slice(2)] = true;
    } else rest.push(a);
  }
  return { cmd: rest[0], opts };
}

const USAGE = `Utilisation :
  node scripts/license.mjs keygen [--out ${DEFAULT_KEY_FILE}] [--force]
  node scripts/license.mjs issue --company "Société" --phone XXXX-XXXX-XXXX-XXXX --expires AAAA-MM-JJ [--key ${DEFAULT_KEY_FILE}] [--serial ID]`;

function main(argv) {
  const { cmd, opts } = parseArgs(argv);
  if (cmd === 'keygen') {
    const { path, publicKey } = keygen(typeof opts.out === 'string' ? opts.out : DEFAULT_KEY_FILE, { force: opts.force === true });
    console.log(`Clé privée écrite dans ${path}`);
    console.log('Gardez ce fichier secret, hors du dépôt, et SAUVEGARDEZ-LE MAINTENANT (clé USB chiffrée, gestionnaire de mots de passe…) :');
    console.log('sans lui, aucun nouveau code ne peut être émis pour les builds existants.\n');
    console.log('Clé publique à coller dans app.json > expo.extra.licensePublicKey :\n');
    console.log(publicKey);
    return 0;
  }
  if (cmd === 'issue') {
    for (const k of ['company', 'phone', 'expires']) {
      if (typeof opts[k] !== 'string') throw new Error(`Option --${k} manquante.\n\n${USAGE}`);
    }
    const serial = typeof opts.serial === 'string' ? opts.serial : newSerial();
    const code = issue({ company: opts.company, phone: opts.phone, expires: opts.expires, serial, key: typeof opts.key === 'string' ? opts.key : DEFAULT_KEY_FILE });
    if (opts.expires < L.localIsoDate(Date.now())) console.error(`Attention : la date d'expiration ${L.frDate(opts.expires)} est déjà passée, ce code sera refusé.`);
    console.error(`Licence ${serial} · ${opts.company.trim()} · téléphone ${L.formatPhoneCode(opts.phone)} · jusqu'au ${L.frDate(opts.expires)} inclus\n`);
    console.log(code);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
