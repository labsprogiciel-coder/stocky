/**
 * Scanner plein écran (caméra + saisie manuelle).
 *
 * Résolution d'un code : numéro de série / IMEI d'un appareil → code-barres /
 * SKU d'un article → code inconnu.
 * - Appareil : fiche rapide (article, n° de série, IMEI, statut, attributaire)
 *   et actions selon le statut (Attribuer, Envoyer en réparation, Retirer,
 *   Remettre en stock).
 * - Article suivi par numéro de série : Entrée = « Ajouter des appareils »
 *   (boucle : chaque code lu est ajouté comme numéro de série, sauf un IMEI ou
 *   un code-barres produit EAN/UPC lu par la caméra ; le scanner reste prêt
 *   pour le suivant) ; la Sortie se fait en scannant l'appareil lui-même.
 * - Article suivi en quantité : panneau Entrée / Sortie inchangé.
 * - Code inconnu : « Créer l'article » ou « Ajouter comme appareil ».
 *
 * Paramètres :
 * - `?countId=…` : comptage. Le code est transmis à l'écran de comptage
 *   (`setPendingCountScan`), qui marque l'appareil trouvé ou va sur l'article.
 *   Avec `&multi=1` (« Scanner les appareils ») : le scanner reste ouvert et
 *   chaque numéro de série lu est marqué trouvé (`markUnitFound`).
 * - `?pick=serial|imei|imei2` : sélection pour un formulaire d'appareil ; le code lu
 *   est transmis au retour (`setPendingPick`).
 * - `?addItemId=…` : ouvre directement la boucle « Ajouter des appareils ».
 * - `?box=1` (option `&addItemId=…`) : « Scanner une boîte ». La caméra reste
 *   active et accumule tous les codes distincts de l'étiquette ; chacun reçoit
 *   un rôle (N° de série, IMEI 1, IMEI 2, Code produit, Autre — règles
 *   génériques de `data/boxLabel.ts`), l'article est déduit du code produit
 *   (`data/boxDevice.ts`) et « Ajouter l'appareil » l'enregistre en une fois.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, TextInput, Vibration, KeyboardAvoidingView, Platform, Linking, ScrollView } from 'react-native';
import { router, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Btn, Icon, Segmented, Stepper, SerialBadge, UnitStatusChip, Alert as InlineAlert } from '../components/ui';
import { colors } from '../constants/theme';
import { openProSection } from '../components/ProNotice';
import {
  BOX_CHIP_LABELS,
  analyzeBoxSession,
  BOX_MAX_CODES,
  boxActiveKeys,
  boxAddCode,
  boxCheckCode,
  boxRejectDigest,
  boxChooseSerial,
  boxCodeKey,
  boxFieldChip,
  boxHasCode,
  boxListFields,
  boxIsIgnored,
  boxReset,
  emptyBoxSession,
  normalizeBoxText,
  type BoxAnalysis,
  type BoxChip,
  type BoxSession,
} from '../data/boxLabel';
import { addDeviceFromBox, analyzeBoxForStore, boxDuplicateError, boxImeis, boxTargetItem, resolveBoxArticle } from '../data/boxDevice';
import {
  UNIT_STATUS_LABELS,
  addUnit,
  commitMovement,
  findItemByCode,
  findUnitByCode,
  fmtCount,
  getCountItems,
  getItem,
  getItems,
  getPrefs,
  getUnits,
  imeiDigits,
  isValidImei,
  markUnitFound,
  setCountIndex,
  setPendingCountScan,
  setPendingPick,
  unitLimitError,
  updateUnit,
  type Item,
  type PickTarget,
  type Unit,
  type UnitStatus,
} from '../data/store';

const BARCODE_TYPES: BarcodeType[] = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'qr'];

/**
 * Symbologies des codes-barres produit (EAN-13/8, UPC-A/E), d'après le `type`
 * renvoyé par la caméra (`ean13`, `upc_a`… ; insensible à la casse). Dans la
 * boucle « Ajouter des appareils », ces lectures ne deviennent jamais des
 * numéros de série (un S/N est en Code 128, Code 39 ou QR).
 */
const PRODUCT_SYMBOLOGY = /^(ean_?(13|8)|upc_?[ae])$/i;

/** Délai avant d'accepter une nouvelle lecture dans les modes « à la suite ». */
const LOOP_UNLOCK_MS = 700;
/**
 * Hors boucle, au retour au scanner : le code qui vient d'être traité est
 * ignoré tant qu'il reste dans le champ de la caméra (lu à moins de ce délai
 * de la lecture précédente).
 */
const SUPPRESS_GAP_MS = 1200;

type Match = { kind: 'unit'; unit: Unit; item: Item } | { kind: 'item'; item: Item } | null;

/** Appareil (n° de série / IMEI) d'abord, puis article (code-barres / SKU). */
function resolveCode(code: string): Match {
  const unit = findUnitByCode(code);
  const unitItem = unit ? getItem(unit.itemId) : undefined;
  if (unit && unitItem) return { kind: 'unit', unit, item: unitItem };
  const item = findItemByCode(code);
  return item ? { kind: 'item', item } : null;
}

/** `pro` : refus par la limite de la version gratuite (lien vers Stockly Pro). */
type Feedback = { kind: 'ok' | 'error' | 'info'; text: string; unitId?: string; pro?: boolean };

export default function Scan() {
  const params = useLocalSearchParams<{ countId?: string; multi?: string; pick?: string; addItemId?: string; box?: string }>();
  const countTarget = typeof params.countId === 'string' && params.countId.length > 0 ? params.countId : null;
  const countMode = countTarget !== null;
  const multiCount = countMode && params.multi === '1';
  const pickTarget: PickTarget | null = !countMode && (params.pick === 'serial' || params.pick === 'imei' || params.pick === 'imei2') ? params.pick : null;
  const launchedBox = !countMode && !pickTarget && params.box === '1';
  const paramAddId = typeof params.addItemId === 'string' && params.addItemId.length > 0 ? params.addItemId : null;
  const launchedAddId = !countMode && !pickTarget && !launchedBox ? paramAddId : null;

  const [perm, requestPerm] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [mode, setMode] = useState<'Entrée' | 'Sortie'>('Entrée');
  const [qty, setQty] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState('');
  // Incrémenté au retour sur l'écran pour relire le store (ex. article créé).
  const [, setRefresh] = useState(0);
  // Boucle « Ajouter des appareils » : article cible.
  const [addTargetId, setAddTargetId] = useState<string | null>(launchedAddId);
  const [addedCount, setAddedCount] = useState(0);
  // Comptage « Scanner les appareils » : appareils trouvés pendant ce scan.
  const [foundCount, setFoundCount] = useState(0);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // Boucle d'ajout : code lu par la caméra, en attente de confirmation
  // (une étiquette porte souvent d'autres codes : référence, modèle…).
  const [pendingSerial, setPendingSerial] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  // Panneau appareil : saisie de l'attributaire.
  const [assigning, setAssigning] = useState(false);
  const [assignee, setAssignee] = useState('');
  // Code inconnu : choix de l'article pour « Ajouter comme appareil ».
  const [pickArticle, setPickArticle] = useState(false);
  // Verrou synchrone : la caméra peut émettre plusieurs lectures avant le rendu.
  const lockedRef = useRef(false);
  // Verrou synchrone contre le double appui sur Valider (le state est groupé par React).
  const committingRef = useRef(false);
  // Boucles (ajout d'appareils, comptage) : codes déjà lus par la caméra
  // pendant la boucle, ignorés ensuite. La caméra lit tout le champ, pas
  // seulement le cadre : les autres codes d'une étiquette (IMEI 1, IMEI 2…)
  // et le code-barres de la boîte ne sont traités qu'une fois.
  const loopSeenRef = useRef<Set<string>>(new Set());
  // Retour de « Scanner une boîte » vers la boucle d'ajout : clés (`boxCodeKey`) des
  // codes de la boîte, encore visibles ou récemment ignorés, à ne pas reproposer.
  const loopBoxKeysRef = useRef<Set<string>>(new Set());
  // « Scanner une boîte » : codes caméra déjà écartés (QR Wi-Fi, code trop long),
  // message affiché une seule fois par code pour ne pas masquer les autres.
  const boxRejectedRef = useRef<Set<string>>(new Set());
  // Hors boucle : code qui vient d'être traité, ignoré tant qu'il reste visible.
  const suppressRef = useRef<{ code: string; lastSeen: number } | null>(null);
  // Écran recouvert (fiche appareil, autre scanner…) : caméra démontée, aucune lecture.
  const focused = useIsFocused();
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // « Scanner une boîte » : codes de l'étiquette en cours (copie synchrone dans
  // boxRef : la caméra émet plusieurs lectures avant le rendu).
  const [boxActive, setBoxActive] = useState(launchedBox);
  // Article choisi (paramètre, liste ou boîte précédente) ; sinon déduit du code produit.
  const [boxItemId, setBoxItemId] = useState<string | null>(launchedBox ? paramAddId : null);
  // Article déduit du code produit de la boîte précédente : repli pour une boîte sans
  // code produit lisible ; un code produit lu sur la boîte suivante l'emporte toujours.
  const [boxAutoId, setBoxAutoId] = useState<string | null>(null);
  // Boîte ouverte depuis la boucle « Ajouter des appareils » : « Terminer » y revient.
  const [boxReturnAddId, setBoxReturnAddId] = useState<string | null>(null);
  const [boxSession, setBoxSession] = useState<BoxSession>(emptyBoxSession);
  const boxRef = useRef<BoxSession>(boxSession);
  const [boxAdded, setBoxAdded] = useState(0);
  const [boxPicking, setBoxPicking] = useState(false);
  // « Modifier » : formulaire d'appareil ouvert ; au retour, un appareil ajouté termine la boîte.
  const boxEditRef = useRef<{ before: Set<string>; itemId: string; explicit: boolean } | null>(null);

  useEffect(() => () => {
    if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
  }, []);

  useFocusEffect(
    useCallback(() => {
      setRefresh((n) => n + 1);
    }, [])
  );

  // Retour du formulaire « Modifier » de « Scanner une boîte ».
  useFocusEffect(
    useCallback(() => {
      const pending = boxEditRef.current;
      if (!pending) return;
      boxEditRef.current = null;
      // Appareils de l'article apparus pendant que le formulaire était ouvert.
      const fresh = getUnits(pending.itemId).filter((u) => !pending.before.has(u.id));
      if (fresh.length === 0) return;
      const last = fresh[fresh.length - 1];
      setBoxAdded((n) => n + fresh.length);
      setFeedback({ kind: 'ok', text: `Appareil ajouté : ${last.serial}`, unitId: last.id });
      if (!pending.explicit) setBoxAutoId(pending.itemId);
      const next = boxReset(boxRef.current, Date.now());
      boxRef.current = next;
      setBoxSession(next);
    }, [])
  );

  const match = code ? resolveCode(code) : null;
  const unitMatch = match?.kind === 'unit' ? match : null;
  const item = match?.kind === 'item' ? match.item : null;
  const qtyItem = item && !item.serialized ? item : null;
  const serialItem = item?.serialized ? item : null;
  const unknownCode = code !== null && match === null;
  const addTargetRaw = addTargetId ? getItem(addTargetId) : undefined;
  const addTarget = addTargetRaw?.serialized ? addTargetRaw : null;
  const addLoop = addTarget !== null && !countMode && !pickTarget;
  const boxMode = boxActive && !countMode && !pickTarget;
  const loop = addLoop || multiCount || boxMode;

  // « Scanner une boîte » : rôles des codes, article cible, doublons.
  const boxAnalysis = boxMode ? analyzeBoxForStore(boxSession) : null;
  const boxResolved = boxAnalysis ? resolveBoxArticle(boxAnalysis) : null;
  const boxChosenRaw = boxItemId ? getItem(boxItemId) : undefined;
  const boxItem: Item | null = boxResolved ? boxTargetItem(boxResolved, boxItemId, boxAutoId) : null;
  const boxDup = boxAnalysis ? boxDuplicateError(boxAnalysis) : null;

  // ── qty validation ────────────────────────────────────────────────────────
  const qtyError =
    qty <= 0
      ? 'La quantité doit être supérieure à 0.'
      : mode === 'Sortie' && qtyItem && qty > qtyItem.qty
      ? `Stock insuffisant — disponible : ${qtyItem.qty} unité(s).`
      : null;

  const canSubmit = !!qtyItem && !qtyError;

  // ── handlers ──────────────────────────────────────────────────────────────
  const scheduleUnlock = () => {
    if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
    unlockTimerRef.current = setTimeout(() => {
      unlockTimerRef.current = null;
      lockedRef.current = false;
    }, LOOP_UNLOCK_MS);
  };

  /** Enregistre `data` comme numéro de série d'un nouvel appareil de `target`. */
  const commitSerial = (target: Item, data: string) => {
    const res = addUnit(target.id, { serial: data });
    if (res.error !== undefined) {
      setFeedback({ kind: 'error', text: res.error, ...(res.limit === 'units' ? { pro: true } : {}) });
      return;
    }
    setAddedCount((n) => n + 1);
    setFeedback({ kind: 'ok', text: `Ajouté : ${res.unit.serial}`, unitId: res.unit.id });
    setRefresh((n) => n + 1);
  };

  /**
   * Boucle « Ajouter des appareils » : le code lu devient un numéro de série de `target`.
   * Lu par la caméra, il est d'abord proposé (retourne `true`, scanner verrouillé
   * jusqu'à « Ajouter » ou « Ignorer ») ; saisi à la main, il est ajouté directement.
   */
  const addSerial = (target: Item, data: string, source: 'camera' | 'manual', symbology?: string): boolean => {
    // Un IMEI (15 chiffres, clé de Luhn valide) lu sur l'étiquette n'est pas
    // un numéro de série. La saisie manuelle reste possible.
    if (source === 'camera' && isValidImei(imeiDigits(data)) && !findUnitByCode(data)) {
      setFeedback({
        kind: 'info',
        text: `Code ${data} ignoré : il ressemble à un IMEI. Scannez le numéro de série (S/N) ; l'IMEI s'ajoute depuis « Compléter ».`,
      });
      return false;
    }
    const asItem = findItemByCode(data);
    if (asItem) {
      // Le code-barres de l'article lui-même, encore dans le cadre : ignoré.
      if (asItem.id === target.id && source === 'camera') return false;
      setFeedback({
        kind: 'error',
        text: asItem.id === target.id
          ? "C'est le code de l'article lui-même : saisissez le numéro de série de l'appareil."
          : `Ce code est celui de l'article « ${asItem.name} », pas un numéro de série.`,
      });
      return false;
    }
    // Code-barres produit (EAN/UPC) d'un carton, lu en même temps que le S/N :
    // ce n'est pas un numéro de série. La saisie manuelle reste possible.
    if (source === 'camera' && symbology !== undefined && PRODUCT_SYMBOLOGY.test(symbology)) {
      setFeedback({
        kind: 'info',
        text: `Code ${data} ignoré : c'est un code-barres produit (EAN/UPC). Scannez le numéro de série (S/N) ou saisissez-le manuellement.`,
      });
      return false;
    }
    const known = findUnitByCode(data);
    if (known) {
      setFeedback({ kind: 'error', text: `Appareil déjà enregistré : ${known.serial}${getItem(known.itemId) ? ` · ${getItem(known.itemId)!.name}` : ''}` });
      return false;
    }
    // Version gratuite : limite d'appareils atteinte, rien n'est proposé ni ajouté.
    // Vérifiée après les codes déjà connus, pour que leur message reste exact.
    const limit = unitLimitError();
    if (limit) {
      setFeedback({ kind: 'error', text: limit, pro: true });
      return false;
    }
    if (source === 'camera') {
      setFeedback(null);
      pendingRef.current = data;
      setPendingSerial(data);
      return true;
    }
    commitSerial(target, data);
    return false;
  };

  // Copie synchrone de pendingSerial : un double appui arrive avant le rendu.
  const takePending = () => {
    const v = pendingRef.current;
    pendingRef.current = null;
    setPendingSerial(null);
    return v;
  };

  const confirmPending = () => {
    if (!addTarget) return;
    const serial = takePending();
    if (!serial) return;
    commitSerial(addTarget, serial);
    scheduleUnlock();
  };

  const ignorePending = () => {
    const serial = takePending();
    if (!serial) return;
    // Déjà dans loopSeenRef : ce code ne sera plus proposé pendant la boucle.
    setFeedback({ kind: 'info', text: `Ignoré : ${serial}` });
    scheduleUnlock();
  };



  /** Comptage « Scanner les appareils » : marque l'appareil trouvé, sans quitter le scanner. */
  const countSerial = (countId: string, data: string) => {
    const unit = findUnitByCode(data);
    if (unit) {
      const res = markUnitFound(countId, data);
      if (!res.ok) {
        setFeedback({ kind: 'error', text: res.error });
        return;
      }
      const name = getItem(res.itemId)?.name;
      const i = getCountItems(countId).findIndex((x) => x.id === res.itemId);
      // L'écran de comptage s'ouvrira sur cet article au retour.
      if (i >= 0) setCountIndex(countId, i);
      if (res.duplicate) {
        setFeedback({ kind: 'info', text: `Déjà compté : ${unit.serial}${name ? ` · ${name}` : ''}` });
      } else {
        setFoundCount((n) => n + 1);
        setFeedback({ kind: 'ok', text: `Trouvé : ${unit.serial}${name ? ` · ${name}` : ''}` });
      }
      return;
    }
    const it = findItemByCode(data);
    if (it) {
      const i = getCountItems(countId).findIndex((x) => x.id === it.id);
      if (i < 0) {
        setFeedback({ kind: 'error', text: `Article hors comptage : ${it.name}` });
        return;
      }
      setCountIndex(countId, i);
      setFeedback({
        kind: 'info',
        text: it.serialized
          ? `Article « ${it.name} » : scannez le numéro de série de chaque appareil.`
          : `« ${it.name} » est suivi en quantité : saisissez sa quantité dans le comptage.`,
      });
      return;
    }
    setFeedback({ kind: 'error', text: `Code inconnu : ${data}` });
  };

  // ── « Scanner une boîte » ────────────────────────────────────────────────
  /** Remplace la session ; ne rend l'écran que si la liste ou le choix change. Renvoie `true` si un code a été ajouté. */
  const applyBox = (next: BoxSession): boolean => {
    const prev = boxRef.current;
    boxRef.current = next;
    if (next.codes !== prev.codes || next.chosenFieldId !== prev.chosenFieldId || next.full !== prev.full) setBoxSession(next);
    return next.codes.length > prev.codes.length;
  };

  /** Boîte suivante : liste vidée (les codes encore visibles restent ignorés), article conservé. */
  const nextBox = () => {
    // Article déduit du code produit : gardé seulement en repli (voir boxAutoId).
    if (!boxItemId && boxItem) setBoxAutoId(boxItem.id);
    applyBox(boxReset(boxRef.current, Date.now()));
  };

  /**
   * Analyse de la session à jour (synchrone) et son article cible. Un code lu
   * par la caméra entre le dernier rendu et l'appui peut changer l'article :
   * dans ce cas rien n'est fait, l'aperçu est mis à jour et un nouvel appui est demandé.
   */
  const boxSnapshot = (): { a: BoxAnalysis; target: Item } | null => {
    if (!boxItem) return null;
    const a = analyzeBoxForStore(boxRef.current);
    const target = boxTargetItem(resolveBoxArticle(a), boxItemId, boxAutoId);
    if (!target || target.id !== boxItem.id) {
      setBoxSession(boxRef.current);
      setFeedback({ kind: 'info', text: "L'article a changé avec le dernier code lu : vérifiez-le, puis touchez de nouveau le bouton." });
      return null;
    }
    return { a, target };
  };

  const addFromBox = () => {
    if (committingRef.current || !boxItem) return;
    // Session à jour (synchrone) : un double appui ne réenregistre pas la boîte.
    const snap = boxSnapshot();
    if (!snap) return;
    const { a, target } = snap;
    if (!a.serial) return;
    committingRef.current = true;
    const res = addDeviceFromBox(target.id, a);
    committingRef.current = false;
    if (res.error !== undefined) {
      setFeedback({ kind: 'error', text: res.error, ...(res.limit === 'units' ? { pro: true } : {}) });
      return;
    }
    setBoxAdded((n) => n + 1);
    setFeedback({ kind: 'ok', text: `Appareil ajouté : ${res.unit.serial}`, unitId: res.unit.id });
    nextBox();
    setRefresh((n) => n + 1);
  };

  /** « Modifier » : formulaire d'appareil prérempli (numéro de série, IMEI 1, IMEI 2). */
  const editBox = () => {
    const snap = boxSnapshot();
    if (!snap) return;
    const { a, target } = snap;
    const { imei, imei2 } = boxImeis(a);
    boxEditRef.current = { before: new Set(getUnits(target.id).map((u) => u.id)), itemId: target.id, explicit: boxItemId !== null };
    router.push({
      pathname: '/unit/new',
      params: { itemId: target.id, serial: a.serial?.value ?? '', ...(imei ? { imei } : {}), ...(imei2 ? { imei2 } : {}) },
    });
  };

  /** `fromLoop` : ouvert depuis « Ajouter des appareils » (« Terminer » y revient). */
  const startBox = (itemId: string | null, fromLoop = false) => {
    if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
    unlockTimerRef.current = null;
    loopSeenRef.current = new Set();
    loopBoxKeysRef.current = new Set();
    boxRejectedRef.current = new Set();
    pendingRef.current = null;
    setPendingSerial(null);
    setAddTargetId(null);
    if (!fromLoop) setAddedCount(0);
    setBoxReturnAddId(fromLoop ? itemId : null);
    setBoxActive(true);
    setBoxItemId(itemId);
    setBoxAutoId(null);
    setBoxAdded(0);
    setBoxPicking(false);
    setFeedback(null);
    setManualOpen(false);
    setManualText('');
    applyBox(emptyBoxSession());
    handleReset();
  };

  const finishBox = () => {
    const back = boxReturnAddId;
    boxRejectedRef.current = new Set();
    if (back) {
      // Retour à la boucle « Ajouter des appareils » : les codes de cette boîte
      // (liste en cours et codes de la boîte précédente encore ignorés après un
      // ajout ou « Boîte suivante »), encore visibles, n'y sont pas reproposés.
      loopSeenRef.current = new Set(boxRef.current.codes.map((c) => c.data));
      loopBoxKeysRef.current = new Set(boxActiveKeys(boxRef.current, Date.now()));
      setAddTargetId(back);
      setAddedCount((n) => n + boxAdded);
    } else if (launchedBox || launchedAddId) {
      router.back();
      return;
    }
    setBoxActive(false);
    setBoxItemId(null);
    setBoxAutoId(null);
    setBoxReturnAddId(null);
    setBoxAdded(0);
    setBoxPicking(false);
    setFeedback(null);
    setManualOpen(false);
    setManualText('');
    applyBox(emptyBoxSession());
    handleReset();
  };

  /** `symbology` : type du code lu par la caméra (absent en saisie manuelle). */
  const handleCode = (raw: string, source: 'camera' | 'manual', symbology?: string) => {
    const data = raw.trim();
    if (!data || !focused) return;
    if (boxMode) {
      // Code trop long, QR Wi-Fi / contact : écarté entièrement (message sans son contenu).
      const rejected = boxCheckCode(data);
      if (rejected !== null) {
        if (source === 'manual') {
          setManualText('');
          setManualOpen(false);
          setFeedback({ kind: 'info', text: rejected });
          return;
        }
        // Caméra : une seule fois par code, et sans remplacer un message d'ajout ou d'erreur.
        // Empreinte seulement (le contenu, ex. mot de passe Wi-Fi, n'est pas gardé).
        const digest = boxRejectDigest(data);
        if (boxRejectedRef.current.has(digest)) return;
        if (boxRejectedRef.current.size >= 50) boxRejectedRef.current = new Set();
        boxRejectedRef.current.add(digest);
        setFeedback((f) => (f && f.kind !== 'info' ? f : { kind: 'info', text: rejected }));
        return;
      }
      // Chaque code distinct de l'étiquette est gardé ; les doublons sont ignorés sans bruit.
      const before = boxRef.current;
      const added = applyBox(boxAddCode(before, { data, ...(symbology ? { type: symbology } : {}) }));
      if (source === 'manual') {
        // Retour à la liste : l'utilisateur voit le rôle attribué au code saisi.
        setManualText('');
        setManualOpen(false);
        setFeedback({
          kind: 'info',
          text: added
            ? `Code ajouté à la liste : ${data}`
            : boxHasCode(before, data)
            ? `Code déjà dans la liste : ${data}`
            : boxIsIgnored(before, data)
            ? `Code de la boîte précédente, encore visible : non ajouté. Réessayez dans un instant.`
            : before.codes.length >= BOX_MAX_CODES
            ? `Liste pleine (${BOX_MAX_CODES} codes) : code non ajouté. Touchez le bon code dans la liste, ou « Boîte suivante » pour recommencer.`
            : `Code non ajouté : ${data}`,
        });
        return;
      }
      if (added) {
        if (source === 'camera' && getPrefs().vibration) Vibration.vibrate(40);
        // Une erreur de la tentative précédente n'a plus lieu d'être.
        setFeedback((f) => (f && f.kind !== 'ok' ? null : f));
      }
      return;
    }
    if (source === 'camera') {
      // Dans une boucle, chaque code n'est lu qu'une fois.
      if (loop && loopSeenRef.current.has(data)) return;
      // Ajout d'appareils : un QR Wi-Fi / contact ou un code trop long n'est jamais
      // un numéro de série ; écarté sans être proposé (ni affiché).
      if (addLoop && boxCheckCode(data) !== null) return;
      // Codes de la boîte tout juste terminée (même clé que « Scanner une boîte »).
      if (loop && loopBoxKeysRef.current.size > 0 && loopBoxKeysRef.current.has(boxCodeKey(normalizeBoxText(data), symbology))) return;
      // Hors boucle : le code tout juste traité, encore dans le champ, est ignoré.
      const sup = suppressRef.current;
      if (!loop && sup && sup.code === data) {
        const now = Date.now();
        const stillInView = now - sup.lastSeen < SUPPRESS_GAP_MS;
        sup.lastSeen = now;
        if (stillInView) return;
      }
    }
    if (lockedRef.current) return;
    lockedRef.current = true;
    if (source === 'camera') {
      if (loop) loopSeenRef.current.add(data);
      suppressRef.current = null;
      if (getPrefs().vibration) Vibration.vibrate(60);
    }

    if (pickTarget) {
      setPendingPick(pickTarget, data);
      router.back();
      return;
    }

    if (countTarget) {
      if (!multiCount) {
        setPendingCountScan(countTarget, data);
        router.back();
        return;
      }
      countSerial(countTarget, data);
      if (source === 'manual') setManualText('');
      scheduleUnlock();
      return;
    }

    if (addLoop) {
      // Saisie manuelle d'un QR Wi-Fi / contact ou d'un code trop long : jamais un
      // numéro de série (message fixe, sans le contenu saisi).
      const refused = source === 'manual' ? boxCheckCode(data) : null;
      if (refused !== null) {
        setManualText('');
        setFeedback({ kind: 'error', text: refused });
        scheduleUnlock();
        return;
      }
      const pending = addSerial(addTarget, data, source, symbology);
      if (source === 'manual') setManualText('');
      if (pending) {
        // Reste verrouillé jusqu'à la réponse de l'utilisateur.
        if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
        unlockTimerRef.current = null;
      } else {
        scheduleUnlock();
      }
      return;
    }

    setCode(data);
    setManualOpen(false);
    setManualText('');
    setError(null);
    setQty(1);
    setMode('Entrée');
    setAssigning(false);
    setAssignee('');
    setPickArticle(false);
  };

  const handleReset = () => {
    // Le code qui vient d'être traité (souvent encore devant la caméra) n'est
    // relu qu'après être sorti du champ.
    if (code) suppressRef.current = { code, lastSeen: Date.now() };
    lockedRef.current = false;
    committingRef.current = false;
    setCode(null);
    setQty(1);
    setMode('Entrée');
    setError(null);
    setAssigning(false);
    setAssignee('');
    setPickArticle(false);
  };

  const startAddLoop = (target: Item) => {
    // Le code-barres de l'article, encore dans le cadre, ne doit pas être ajouté.
    loopSeenRef.current = new Set(code ? [code] : []);
    loopBoxKeysRef.current = new Set();
    setAddTargetId(target.id);
    setAddedCount(0);
    setFeedback(null);
    handleReset();
  };

  const finishLoop = () => {
    if (multiCount || launchedAddId) {
      router.back();
      return;
    }
    if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
    unlockTimerRef.current = null;
    loopSeenRef.current = new Set();
    loopBoxKeysRef.current = new Set();
    pendingRef.current = null;
    setPendingSerial(null);
    setAddTargetId(null);
    setFeedback(null);
    setManualOpen(false);
    setManualText('');
    handleReset();
  };

  const handleCreate = () => {
    if (!code) return;
    router.push({ pathname: '/article/new', params: { barcode: code } });
  };

  const handleValidate = () => {
    if (!qtyItem || !code || qtyError || committingRef.current) return;
    committingRef.current = true;
    const err = commitMovement(code, mode, qty);
    if (err) {
      committingRef.current = false;
      setError(err);
      return;
    }
    Alert.alert(
      'Mouvement enregistré',
      `${mode} · ${qty} × ${qtyItem.name}`,
      [
        { text: 'Scanner un autre', onPress: handleReset },
        { text: 'Fermer', style: 'cancel', onPress: () => router.back() },
      ]
    );
  };

  const applyUnitStatus = (unit: Unit, unitItem: Item, status: UnitStatus) => {
    if (committingRef.current) return;
    committingRef.current = true;
    const res = updateUnit(unit.id, status === 'assigned' ? { status, assignee } : { status });
    if (res.error !== undefined) {
      committingRef.current = false;
      setError(res.error);
      return;
    }
    setAssigning(false);
    setAssignee('');
    setError(null);
    setRefresh((n) => n + 1);
    const detail = status === 'assigned' && res.unit.assignee
      ? `Attribué à ${res.unit.assignee}`
      : UNIT_STATUS_LABELS[status];
    Alert.alert(
      'Appareil mis à jour',
      `${unitItem.name}\nN° de série ${res.unit.serial} · ${detail}`,
      [
        { text: 'Scanner un autre', onPress: handleReset },
        { text: 'Fermer', style: 'cancel', onPress: () => router.back() },
      ]
    );
  };

  const camGranted = !!perm?.granted;
  const scanning = !code && !manualOpen;

  const hint = pickTarget === 'serial'
    ? "Scannez le numéro de série de l'appareil"
    : pickTarget === 'imei'
    ? "Scannez l'IMEI de l'appareil"
    : pickTarget === 'imei2'
    ? "Scannez l'IMEI 2 de l'appareil (double SIM)"
    : multiCount
    ? 'Scannez les numéros de série des appareils'
    : countMode
    ? 'Scannez un article ou un appareil du comptage'
    : addLoop
    ? "Scannez le numéro de série de l'appareil à ajouter"
    : boxMode
    ? "Filmez l'étiquette de la boîte : tous ses codes sont lus"
    : 'Placez le code dans le cadre';

  const manualHelp = pickTarget === 'serial'
    ? "Saisissez le numéro de série de l'appareil."
    : pickTarget === 'imei'
    ? "Saisissez l'IMEI (15 chiffres)."
    : pickTarget === 'imei2'
    ? "Saisissez l'IMEI 2 (15 chiffres)."
    : multiCount
    ? "Saisissez le numéro de série ou l'IMEI de l'appareil trouvé."
    : addLoop
    ? `Saisissez le numéro de série de l'appareil à ajouter à « ${addTarget.name} ».`
    : boxMode
    ? "Saisissez un code de l'étiquette (numéro de série, IMEI…) : il est ajouté à la liste."
    : "Saisissez le code-barres, la référence (SKU), le numéro de série ou l'IMEI.";

  const serialItems = unknownCode && pickArticle ? getItems().filter((i) => i.serialized) : [];
  const boxSerialItems = boxMode && boxPicking ? getItems().filter((i) => i.serialized) : [];

  return (
    <View style={{ flex: 1, backgroundColor: '#101714' }}>
      {camGranted && focused && (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={torch}
          barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
          onBarcodeScanned={scanning ? (r) => handleCode(r.data, 'camera', typeof r.type === 'string' ? r.type : undefined) : undefined}
        />
      )}

      {/* Top action bar */}
      <SafeAreaView style={styles.topBar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Fermer" onPress={() => router.back()} style={styles.iconBtn}>
          <Icon name="x" color="#fff" />
        </Pressable>
        {camGranted && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Lampe torche"
            accessibilityState={{ selected: torch }}
            onPress={() => setTorch((t) => !t)}
            style={[styles.iconBtn, torch && styles.iconBtnActive]}
          >
            <Icon name="zap" color={torch ? colors.primary : '#fff'} />
          </Pressable>
        )}
      </SafeAreaView>

      {/* Viewfinder overlay — shown while no code locked */}
      {scanning && camGranted && (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <View style={styles.maskTop} />
          <View style={styles.centerRow}>
            <View style={styles.maskSide} />
            <View style={styles.frame}>
              <View style={[styles.corner, styles.cornerTL]} />
              <View style={[styles.corner, styles.cornerTR]} />
              <View style={[styles.corner, styles.cornerBL]} />
              <View style={[styles.corner, styles.cornerBR]} />
              <View style={styles.laserLine} />
            </View>
            <View style={styles.maskSide} />
          </View>
          <View style={[styles.maskBottom, loop && styles.maskBottomLoop]}>
            <View style={{ alignItems: 'center', gap: 12 }}>
              <Text style={styles.hintText}>{hint}</Text>
              {!loop && !countMode && !pickTarget && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityHint="Lit tous les codes de l'étiquette d'une boîte (numéro de série, IMEI, code produit) pour ajouter l'appareil en une fois"
                  onPress={() => startBox(null)}
                  style={({ pressed }) => [styles.boxPill, pressed && { opacity: 0.8 }]}
                >
                  <Icon name="package" size={16} color="#fff" />
                  <Text style={styles.boxPillText}>Scanner une boîte</Text>
                </Pressable>
              )}
            </View>
            {!loop && <ManualButton onPress={() => setManualOpen(true)} />}
          </View>
        </View>
      )}

      {/* No camera access — manual entry stays available */}
      {scanning && !camGranted && perm && (
        <SafeAreaView edges={['bottom']} style={[styles.permBox, loop && { justifyContent: 'flex-start', paddingTop: 80 }]}>
          <Text style={{ color: '#fff', fontSize: 16, textAlign: 'center' }}>
            L'accès à la caméra est nécessaire pour scanner les codes-barres.
          </Text>
          {perm.canAskAgain ? (
            <Btn title="Autoriser la caméra" onPress={requestPerm} />
          ) : (
            <Btn title="Ouvrir les réglages" onPress={() => { void Linking.openSettings(); }} />
          )}
          {!loop && <Btn title="Saisie manuelle" variant="outline" onPress={() => setManualOpen(true)} />}
        </SafeAreaView>
      )}

      {/* Manual entry sheet */}
      {!code && manualOpen && (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.sheetHost}
          pointerEvents="box-none"
        >
          <SafeAreaView edges={['bottom']} style={styles.sheetBody}>
            <Text style={{ fontSize: 17, fontWeight: '600', color: colors.text }}>Saisie manuelle</Text>
            <Text style={{ fontSize: 13, color: colors.muted }}>{manualHelp}</Text>
            {loop && feedback && <FeedbackBanner feedback={feedback} action={feedback.pro ? PRO_ACTION : undefined} />}
            <TextInput
              value={manualText}
              onChangeText={setManualText}
              placeholder={pickTarget === 'imei' || pickTarget === 'imei2' ? 'Ex. 356938035643809' : pickTarget || loop ? 'Ex. R58W1A2B3C' : 'Ex. 3760123450003 ou SKU-1000'}
              placeholderTextColor={colors.muted}
              accessibilityLabel={pickTarget === 'imei' ? 'IMEI' : pickTarget === 'imei2' ? 'IMEI 2' : pickTarget || loop ? 'Numéro de série' : 'Code-barres, référence ou numéro de série'}
              autoFocus
              autoCapitalize="characters"
              autoCorrect={false}
              keyboardType={pickTarget === 'imei' || pickTarget === 'imei2' ? 'number-pad' : 'default'}
              returnKeyType={loop ? 'done' : 'search'}
              blurOnSubmit={!loop}
              onSubmitEditing={() => handleCode(manualText, 'manual')}
              style={styles.input}
            />
            <Btn
              title={addLoop ? "Ajouter l'appareil" : multiCount ? "Marquer l'appareil trouvé" : boxMode ? 'Ajouter le code' : 'Valider le code'}
              onPress={() => handleCode(manualText, 'manual')}
              disabled={manualText.trim().length === 0}
            />
            <Btn
              title={camGranted ? 'Revenir au scanner' : loop ? 'Fermer la saisie' : 'Annuler'}
              variant="outline"
              onPress={() => { setManualOpen(false); setManualText(''); }}
            />
          </SafeAreaView>
        </KeyboardAvoidingView>
      )}

      {/* Add-devices loop */}
      {addLoop && !code && !manualOpen && (
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name="plus-circle" size={20} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text accessibilityRole="header" style={{ fontSize: 17, fontWeight: '600', color: colors.text }}>Ajouter des appareils</Text>
              <Text style={{ fontSize: 13, color: colors.muted, marginTop: 2 }}>{addTarget.name}</Text>
            </View>
          </View>
          <Text style={{ fontSize: 13, color: colors.muted }}>
            Scannez le numéro de série de chaque appareil reçu, puis confirmez : il est ajouté « En stock » et le scanner reste prêt pour le suivant.
          </Text>
          {pendingSerial ? (
            <View accessibilityLiveRegion="polite" style={{ backgroundColor: colors.tint, borderRadius: 10, padding: 12, gap: 10 }}>
              <Text style={{ fontSize: 13, color: colors.muted }}>Code lu — est-ce le numéro de série de l'appareil ?</Text>
              <Text selectable style={{ fontSize: 17, fontWeight: '600', color: colors.text }}>{pendingSerial}</Text>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Btn title="Ignorer" variant="outline" accessibilityHint="Ce code ne sera plus proposé pendant cet ajout" onPress={ignorePending} style={{ flex: 1 }} />
                <Btn title="Ajouter" accessibilityHint={`Ajoute un appareil à ${addTarget.name}`} onPress={confirmPending} style={{ flex: 1 }} />
              </View>
            </View>
          ) : feedback && (
            <FeedbackBanner
              feedback={feedback}
              action={
                feedback.pro
                  ? PRO_ACTION
                  : feedback.unitId
                  ? { label: 'Compléter (IMEI, statut…)', onPress: () => router.push(`/unit/${feedback.unitId}`) }
                  : undefined
              }
            />
          )}
          <Text style={{ fontSize: 13, color: colors.text }}>
            {fmtCount(addedCount, 'appareil ajouté', 'appareils ajoutés')} · Stock : {addTarget.qty} en stock
          </Text>
          {!pendingSerial && (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn title="Saisir un n° de série" variant="outline" style={{ flex: 1, paddingHorizontal: 8 }} onPress={() => setManualOpen(true)} />
              <Btn
                title="Scanner une boîte"
                variant="outline"
                style={{ flex: 1, paddingHorizontal: 8 }}
                accessibilityHint="Lit tous les codes de l'étiquette (numéro de série, IMEI 1 et 2, code produit) pour ajouter l'appareil en une fois"
                onPress={() => startBox(addTarget.id, true)}
              />
            </View>
          )}
          <Btn title="Terminer" onPress={finishLoop} />
        </SafeAreaView>
      )}

      {/* Scanner une boîte */}
      {boxMode && boxAnalysis && !manualOpen && (
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name="package" size={20} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text accessibilityRole="header" style={{ fontSize: 17, fontWeight: '600', color: colors.text }}>Scanner une boîte</Text>
              <Text style={{ fontSize: 13, color: colors.muted, marginTop: 2 }}>
                {fmtCount(boxAdded, 'appareil ajouté', 'appareils ajoutés')} pendant ce scan
              </Text>
            </View>
            <Pressable accessibilityRole="button" onPress={finishBox} style={styles.textBtn}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.primary }}>Terminer</Text>
            </Pressable>
          </View>

          {boxPicking ? (
            <>
              <Text style={{ fontSize: 13, color: colors.text }}>Article de l'appareil :</Text>
              {boxSerialItems.length === 0 ? (
                <>
                  <Text style={{ fontSize: 13, color: colors.muted }}>
                    Aucun article n'est suivi par numéro de série. Créez d'abord l'article de l'appareil (ex. le modèle de téléphone).
                  </Text>
                  <Btn
                    title="Créer un article suivi par n° de série"
                    onPress={() => {
                      // Au retour, l'article créé (avec le code produit de la boîte) est retrouvé automatiquement.
                      setBoxPicking(false);
                      router.push({ pathname: '/article/new', params: { serialized: '1', ...(boxAnalysis.ean ? { barcode: boxAnalysis.ean } : {}) } });
                    }}
                  />
                </>
              ) : (
                <ScrollView style={{ maxHeight: 260 }} keyboardShouldPersistTaps="handled">
                  {boxSerialItems.map((it) => (
                    <Pressable
                      key={it.id}
                      accessibilityRole="button"
                      accessibilityLabel={`${it.name}, ${it.qty} en stock`}
                      accessibilityState={{ selected: boxItem?.id === it.id }}
                      onPress={() => { setBoxItemId(it.id); setBoxPicking(false); }}
                      style={styles.pickRow}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>{it.name}</Text>
                        <Text style={{ fontSize: 13, color: colors.muted }}>{it.folder} · {it.qty} en stock</Text>
                      </View>
                      {boxItem?.id === it.id ? <Icon name="check" size={18} color={colors.primary} /> : <Icon name="chevron-right" size={18} color={colors.muted} />}
                    </Pressable>
                  ))}
                </ScrollView>
              )}
              <Btn title="Retour" variant="outline" onPress={() => setBoxPicking(false)} />
            </>
          ) : (
            <>
              <BoxArticleRow
                item={boxItem}
                message={
                  boxItem
                    ? boxResolved?.kind === 'serialized' && boxResolved.item.id !== boxItem.id
                      ? `Le code produit lu est celui de « ${boxResolved.item.name} ».`
                      : null
                    : boxChosenRaw && !boxChosenRaw.serialized
                    ? `« ${boxChosenRaw.name} » est suivi en quantité : choisissez un article suivi par numéro de série.`
                    : boxResolved && (boxResolved.kind === 'quantity' || boxResolved.kind === 'unknown')
                    ? boxResolved.message
                    : null
                }
                onPick={() => setBoxPicking(true)}
              />
              <BoxCodeList analysis={boxAnalysis} onChoose={(id) => applyBox(boxChooseSerial(boxRef.current, id))} />
              {(boxAnalysis.truncated || boxSession.full) && (
                <Text style={{ fontSize: 12, color: colors.warnText }}>
                  Trop de codes lus : les suivants sont ignorés. Touchez « Boîte suivante » pour recommencer.
                </Text>
              )}
              {boxDup && <InlineAlert message={boxDup} />}
              {feedback && (
                <FeedbackBanner
                  feedback={feedback}
                  action={
                    feedback.pro
                      ? PRO_ACTION
                      : feedback.unitId
                      ? { label: "Voir l'appareil", onPress: () => router.push(`/unit/${feedback.unitId}`) }
                      : undefined
                  }
                />
              )}
              <Btn
                title="Ajouter l'appareil"
                accessibilityHint={boxItem ? `Ajoute l'appareil « En stock » à ${boxItem.name}` : "Choisissez d'abord l'article"}
                disabled={!boxAnalysis.serial || !boxItem || boxDup !== null}
                onPress={addFromBox}
              />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Btn
                  title="Boîte suivante"
                  variant="outline"
                  style={{ flex: 1, paddingHorizontal: 6 }}
                  accessibilityHint="Vide la liste des codes ; l'article est conservé"
                  onPress={() => { setFeedback(null); nextBox(); }}
                />
                <Btn
                  title="Modifier"
                  variant="outline"
                  style={{ flex: 1, paddingHorizontal: 6 }}
                  disabled={!boxItem}
                  accessibilityHint="Ouvre le formulaire d'appareil prérempli avec ces codes"
                  onPress={editBox}
                />
                <Btn
                  title="Saisir"
                  variant="outline"
                  style={{ flex: 1, paddingHorizontal: 6 }}
                  accessibilityLabel="Saisir un code"
                  onPress={() => setManualOpen(true)}
                />
              </View>
            </>
          )}
        </SafeAreaView>
      )}

      {/* Count: scan several devices */}
      {multiCount && !manualOpen && (
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name="check-square" size={20} color={colors.primary} />
            <Text accessibilityRole="header" style={{ flex: 1, fontSize: 17, fontWeight: '600', color: colors.text }}>Comptage des appareils</Text>
          </View>
          <Text style={{ fontSize: 13, color: colors.muted }}>
            Scannez le numéro de série (ou l'IMEI) de chaque appareil présent. Le scanner reste prêt pour le suivant.
          </Text>
          {feedback && <FeedbackBanner feedback={feedback} />}
          <Text style={{ fontSize: 13, color: colors.text }}>{fmtCount(foundCount, 'appareil trouvé', 'appareils trouvés')} pendant ce scan</Text>
          <Btn title="Saisir un numéro de série" variant="outline" onPress={() => setManualOpen(true)} />
          <Btn title="Terminer" accessibilityHint="Retour au comptage" onPress={finishLoop} />
        </SafeAreaView>
      )}

      {/* Unknown code banner */}
      {unknownCode && (
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name="alert-circle" size={20} color={colors.warnText} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.warnText }}>Code non reconnu</Text>
              <Text selectable style={{ fontSize: 13, color: colors.muted, marginTop: 2 }}>{code}</Text>
            </View>
          </View>
          {!pickArticle ? (
            <>
              <Text style={{ fontSize: 13, color: colors.muted }}>Aucun article ni appareil ne correspond à ce code sur cet appareil.</Text>
              <Btn title="Créer l'article" accessibilityHint="Crée un article avec ce code-barres" onPress={handleCreate} />
              <Btn
                title="Ajouter comme appareil"
                variant="outline"
                accessibilityHint="Enregistre ce code comme numéro de série d'un article suivi par numéro de série"
                onPress={() => setPickArticle(true)}
              />
              <Btn title="Scanner un autre code" variant="outline" onPress={handleReset} />
            </>
          ) : (
            <>
              <Text style={{ fontSize: 13, color: colors.text }}>
                Ajouter « {code} » comme numéro de série de :
              </Text>
              {serialItems.length === 0 ? (
                <>
                  <Text style={{ fontSize: 13, color: colors.muted }}>
                    Aucun article n'est suivi par numéro de série. Créez d'abord l'article de l'appareil (ex. le modèle de téléphone).
                  </Text>
                  <Btn
                    title="Créer un article suivi par n° de série"
                    onPress={() => router.push({ pathname: '/article/new', params: { serialized: '1' } })}
                  />
                </>
              ) : (
                <ScrollView style={{ maxHeight: 260 }} keyboardShouldPersistTaps="handled">
                  {serialItems.map((it) => (
                    <Pressable
                      key={it.id}
                      accessibilityRole="button"
                      accessibilityLabel={`${it.name}, ${it.qty} en stock`}
                      accessibilityHint="Ouvre le formulaire d'appareil prérempli avec ce numéro de série"
                      onPress={() => router.push({ pathname: '/unit/new', params: { itemId: it.id, serial: code ?? '' } })}
                      style={styles.pickRow}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>{it.name}</Text>
                        <Text style={{ fontSize: 13, color: colors.muted }}>{it.folder} · {it.qty} en stock</Text>
                      </View>
                      <Icon name="chevron-right" size={18} color={colors.muted} />
                    </Pressable>
                  ))}
                </ScrollView>
              )}
              <Btn title="Retour" variant="outline" onPress={() => setPickArticle(false)} />
            </>
          )}
        </SafeAreaView>
      )}

      {/* Scanned device */}
      {unitMatch && (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.sheetHost}
          pointerEvents="box-none"
        >
          <SafeAreaView edges={['bottom']} style={styles.sheetBody}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, color: colors.muted }}>Appareil scanné · {code}</Text>
                <Text style={{ fontSize: 18, fontWeight: '600', marginTop: 2 }}>{unitMatch.item.name}</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Rescanner"
                onPress={handleReset}
                style={styles.smallBtn}
              >
                <Icon name="refresh-cw" size={16} color={colors.muted} />
              </Pressable>
            </View>

            <View style={{ gap: 4 }}>
              <Text style={{ fontSize: 14, color: colors.text }}>
                N° de série : <Text selectable style={{ fontWeight: '600' }}>{unitMatch.unit.serial}</Text>
              </Text>
              {unitMatch.unit.imei !== undefined && (
                <Text style={{ fontSize: 14, color: colors.text }}>
                  IMEI : <Text selectable style={{ fontWeight: '600' }}>{unitMatch.unit.imei}</Text>
                </Text>
              )}
              {unitMatch.unit.imei2 !== undefined && (
                <Text style={{ fontSize: 14, color: colors.text }}>
                  IMEI 2 : <Text selectable style={{ fontWeight: '600' }}>{unitMatch.unit.imei2}</Text>
                </Text>
              )}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}>
                <UnitStatusChip status={unitMatch.unit.status} />
                {unitMatch.unit.assignee !== undefined && (
                  <Text style={{ fontSize: 13, color: colors.muted, flexShrink: 1 }}>Attribué à {unitMatch.unit.assignee}</Text>
                )}
              </View>
            </View>

            {assigning ? (
              <>
                <TextInput
                  value={assignee}
                  onChangeText={(t) => { setAssignee(t); setError(null); }}
                  placeholder="Nom de la personne"
                  placeholderTextColor={colors.muted}
                  accessibilityLabel="Attribué à"
                  autoFocus
                  autoCapitalize="words"
                  returnKeyType="done"
                  onSubmitEditing={() => { if (assignee.trim()) applyUnitStatus(unitMatch.unit, unitMatch.item, 'assigned'); }}
                  style={styles.input}
                />
                <Btn
                  title="Confirmer l'attribution"
                  disabled={assignee.trim().length === 0}
                  onPress={() => applyUnitStatus(unitMatch.unit, unitMatch.item, 'assigned')}
                />
                <Btn title="Annuler" variant="outline" onPress={() => { setAssigning(false); setAssignee(''); setError(null); }} />
              </>
            ) : unitMatch.unit.status === 'in_stock' ? (
              <>
                <Btn title="Attribuer" accessibilityHint="Demande le nom de la personne à qui l'appareil est remis" onPress={() => { setAssigning(true); setError(null); }} />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Btn title="Envoyer en réparation" variant="outline" style={{ flex: 1, paddingHorizontal: 8 }} onPress={() => applyUnitStatus(unitMatch.unit, unitMatch.item, 'repair')} />
                  <Btn title="Retirer" variant="outline" style={{ flex: 1, paddingHorizontal: 8 }} accessibilityHint="Passe l'appareil au statut Retiré (hors service)" onPress={() => applyUnitStatus(unitMatch.unit, unitMatch.item, 'retired')} />
                </View>
              </>
            ) : (
              <Btn title="Remettre en stock" onPress={() => applyUnitStatus(unitMatch.unit, unitMatch.item, 'in_stock')} />
            )}

            {error && <InlineAlert message={error} />}

            {!assigning && (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Btn title="Voir l'appareil" variant="outline" style={{ flex: 1, paddingHorizontal: 8 }} onPress={() => router.push(`/unit/${unitMatch.unit.id}`)} />
                <Btn title="Scanner un autre" variant="outline" style={{ flex: 1, paddingHorizontal: 8 }} onPress={handleReset} />
              </View>
            )}
          </SafeAreaView>
        </KeyboardAvoidingView>
      )}

      {/* Scanned serial-tracked article */}
      {serialItem && (
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 13, color: colors.muted }}>Code scanné · {code}</Text>
              <Text style={{ fontSize: 18, fontWeight: '600' }}>{serialItem.name}</Text>
              <SerialBadge />
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Rescanner" onPress={handleReset} style={styles.smallBtn}>
              <Icon name="refresh-cw" size={16} color={colors.muted} />
            </Pressable>
          </View>
          <Text style={{ fontSize: 13, color: colors.muted }}>
            Stock actuel : <Text style={{ fontWeight: '600', color: colors.text }}>{serialItem.qty}</Text> en stock
            {serialItem.qty <= serialItem.min && (
              <Text style={{ color: colors.warnText }}> · ⚠ Sous le seuil ({serialItem.min})</Text>
            )}
          </Text>
          <Segmented options={['Entrée', 'Sortie']} value={mode} onChange={setMode} />
          {mode === 'Entrée' ? (
            <>
              <Text style={{ fontSize: 13, color: colors.muted }}>
                Article suivi par numéro de série : ajoutez les appareils reçus un par un en scannant ou en saisissant le numéro de série de chacun.
              </Text>
              <Btn title="Ajouter des appareils" onPress={() => startAddLoop(serialItem)} />
              <Btn
                title="Scanner une boîte"
                variant="outline"
                accessibilityHint="Lit tous les codes de l'étiquette (numéro de série, IMEI 1 et 2, code produit) pour ajouter l'appareil en une fois"
                onPress={() => startBox(serialItem.id)}
              />
            </>
          ) : (
            <>
              <Text style={{ fontSize: 13, color: colors.muted }}>
                Pour une sortie, scannez le numéro de série (ou l'IMEI) de l'appareil qui sort : vous pourrez l'attribuer, l'envoyer en réparation ou le retirer.
              </Text>
              <Btn title="Scanner l'appareil" onPress={handleReset} />
            </>
          )}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn title="Voir l'article" variant="outline" style={{ flex: 1, paddingHorizontal: 8 }} onPress={() => router.push(`/article/${serialItem.id}`)} />
            <Btn title="Scanner un autre" variant="outline" style={{ flex: 1, paddingHorizontal: 8 }} onPress={handleReset} />
          </View>
        </SafeAreaView>
      )}

      {/* Scanned item bottom sheet */}
      {qtyItem && (
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          {/* Header row */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, color: colors.muted }}>Code scanné · {code}</Text>
              <Text style={{ fontSize: 18, fontWeight: '600', marginTop: 2 }}>{qtyItem.name}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Rescanner"
              onPress={handleReset}
              style={styles.smallBtn}
            >
              <Icon name="refresh-cw" size={16} color={colors.muted} />
            </Pressable>
          </View>

          {/* Stock context */}
          <Text style={{ fontSize: 13, color: colors.muted }}>
            Stock actuel : <Text style={{ fontWeight: '600', color: colors.text }}>{qtyItem.qty}</Text> unité(s)
            {qtyItem.qty <= qtyItem.min && (
              <Text style={{ color: colors.warnText }}> · ⚠ Sous le seuil ({qtyItem.min})</Text>
            )}
          </Text>

          <Segmented options={['Entrée', 'Sortie']} value={mode} onChange={(v) => { setMode(v); setError(null); }} />
          <Stepper value={qty} onChange={(n) => { setQty(n); setError(null); }} />

          {/* Validation feedback */}
          {qtyError && <InlineAlert message={qtyError} />}
          {error && <InlineAlert message={error} />}

          <Btn title="Valider" onPress={handleValidate} disabled={!canSubmit} />
          <Btn title="Scanner un autre article" variant="outline" onPress={handleReset} />
        </SafeAreaView>
      )}
    </View>
  );
}

const PRO_ACTION = { label: 'Découvrir Stockly Pro', onPress: openProSection };

function FeedbackBanner({ feedback, action }: { feedback: Feedback; action?: { label: string; onPress: () => void } }) {
  const palette = feedback.kind === 'ok'
    ? { bg: colors.tint, fg: colors.primary, icon: 'check-circle' as const }
    : feedback.kind === 'info'
    ? { bg: colors.warnBg, fg: colors.warnText, icon: 'info' as const }
    : { bg: '#FEE2E2', fg: '#B91C1C', icon: 'alert-circle' as const };
  return (
    <View accessibilityLiveRegion="polite" style={{ backgroundColor: palette.bg, borderRadius: 10, padding: 12, gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name={palette.icon} size={16} color={palette.fg} />
        <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: palette.fg }}>{feedback.text}</Text>
      </View>
      {action && (
        <Pressable accessibilityRole="button" onPress={action.onPress} style={{ minHeight: 32, justifyContent: 'center' }}>
          <Text style={{ fontSize: 13, fontWeight: '600', color: colors.primary, textDecorationLine: 'underline' }}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

const CHIP_COLORS: Record<BoxChip, { bg: string; fg: string }> = {
  serial: { bg: colors.primary, fg: '#fff' },
  imei1: { bg: colors.tint, fg: colors.primary },
  imei2: { bg: colors.tint, fg: colors.primary },
  ean: { bg: colors.warnBg, fg: colors.warnText },
  other: { bg: colors.line, fg: colors.muted },
};

/** Article cible de « Scanner une boîte » : nom, ou invitation à le choisir. */
function BoxArticleRow({ item, message, onPick }: { item: Item | null; message: string | null; onPick: () => void }) {
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 14, color: colors.text }} numberOfLines={2}>
          Article : <Text style={{ fontWeight: '600' }}>{item ? item.name : 'à choisir'}</Text>
          {item && <Text style={{ color: colors.muted }}> · {item.qty} en stock</Text>}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel={item ? "Changer d'article" : "Choisir l'article"} onPress={onPick} style={styles.textBtn}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: colors.primary }}>{item ? 'Changer' : "Choisir l'article"}</Text>
        </Pressable>
      </View>
      {message && <Text style={{ fontSize: 12, color: colors.warnText }}>{message}</Text>}
    </View>
  );
}

/** Codes lus sur l'étiquette, avec leur rôle ; toucher un code en fait le numéro de série. */
function BoxCodeList({ analysis, onChoose }: { analysis: BoxAnalysis; onChoose: (fieldId: string | null) => void }) {
  if (analysis.fields.length === 0) {
    return (
      <Text style={{ fontSize: 13, color: colors.muted }}>
        Aucun code lu pour l'instant. Approchez l'étiquette de la boîte : le numéro de série, les IMEI et le code produit sont reconnus.
      </Text>
    );
  }
  // Une même valeur lue dans deux codes (ex. QR + Code 128) n'est listée qu'une fois,
  // avec la pastille du rôle retenu.
  const rows = boxListFields(analysis);
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ fontSize: 12, color: colors.muted }}>Touchez un code pour en faire le numéro de série.</Text>
      <ScrollView style={{ maxHeight: 170 }} keyboardShouldPersistTaps="handled">
        {rows.map((f) => {
          const chip = boxFieldChip(analysis, f);
          const isSerial = chip === 'serial';
          const userChosen = isSerial && analysis.serialSource === 'user';
          const c = CHIP_COLORS[chip];
          const label = BOX_CHIP_LABELS[chip];
          return (
            <Pressable
              key={f.id}
              accessibilityRole="button"
              accessibilityLabel={`${label} : ${f.value}`}
              accessibilityState={{ selected: isSerial }}
              accessibilityHint={userChosen ? 'Annule votre choix : le numéro de série est de nouveau proposé automatiquement' : isSerial ? undefined : "En fait le numéro de série de l'appareil"}
              onPress={() => onChoose(userChosen ? null : f.id)}
              style={styles.boxRow}
            >
              <View style={[styles.chip, { backgroundColor: c.bg }]}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: c.fg }}>{label}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: isSerial ? '700' : '500', color: colors.text }} numberOfLines={1}>{f.value}</Text>
                {isSerial && (
                  <Text style={{ fontSize: 11, color: colors.muted }} numberOfLines={2}>
                    {analysis.serialSource === 'user' ? 'Choisi par vous · touchez pour annuler' : f.reason}
                  </Text>
                )}
              </View>
              {f.multi && <Text style={{ fontSize: 11, color: colors.muted }}>QR</Text>}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function ManualButton({ onPress }: { onPress: () => void }) {
  return (
    <View style={styles.captureContainer}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Saisie manuelle du code"
        onPress={onPress}
        style={({ pressed }) => [
          styles.captureBtnOuter,
          pressed && { transform: [{ scale: 0.94 }], opacity: 0.9 },
        ]}
      >
        <View style={styles.captureBtnInner}>
          <Icon name="edit-3" size={24} color="#fff" />
        </View>
      </Pressable>
      <Text style={styles.captureLabel}>Saisie manuelle</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    zIndex: 10,
  },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnActive: {
    backgroundColor: '#fff',
    borderColor: '#fff',
  },
  maskTop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  centerRow: {
    flexDirection: 'row',
    height: 180,
  },
  maskSide: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  frame: {
    width: 280,
    height: 180,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderColor: '#fff',
    borderWidth: 3.5,
  },
  cornerTL: { top: -2, left: -2, borderBottomWidth: 0, borderRightWidth: 0, borderTopLeftRadius: 18 },
  cornerTR: { top: -2, right: -2, borderBottomWidth: 0, borderLeftWidth: 0, borderTopRightRadius: 18 },
  cornerBL: { bottom: -2, left: -2, borderTopWidth: 0, borderRightWidth: 0, borderBottomLeftRadius: 18 },
  cornerBR: { bottom: -2, right: -2, borderTopWidth: 0, borderLeftWidth: 0, borderBottomRightRadius: 18 },
  laserLine: {
    width: '90%',
    height: 2,
    backgroundColor: colors.primary,
    borderRadius: 1,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 4,
    elevation: 3,
  },
  maskBottom: {
    flex: 1.5,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    paddingTop: 18,
    justifyContent: 'space-between',
    paddingBottom: 40,
  },
  maskBottomLoop: {
    // Cadre plus haut : la fiche du mode « à la suite » occupe le bas de l'écran.
    flex: 3,
  },
  smallBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 40,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.6)',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  boxPillText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  boxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  chip: {
    minWidth: 84,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    alignItems: 'center',
  },
  textBtn: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 56,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  hintText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
    backgroundColor: 'rgba(0,0,0,0.3)',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 999,
    overflow: 'hidden',
  },
  captureContainer: {
    alignItems: 'center',
    gap: 8,
  },
  captureBtnOuter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: '#fff',
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureBtnInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  permBox: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    gap: 16,
  },
  sheetHost: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#fff',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 20,
    gap: 12,
  },
  sheetBody: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 20,
    gap: 12,
  },
  input: {
    height: 48,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.field,
    borderRadius: 10,
    backgroundColor: '#fff',
    fontSize: 16,
    color: colors.text,
  },
});
