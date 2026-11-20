/**
 * Import depuis Excel (.xlsx) ou CSV (Stockly Pro).
 *
 * Étapes : choix du fichier → feuille et ligne d'en-tête détectées →
 * correspondance des colonnes (modifiable champ par champ, « Ignorer ») et
 * aperçu des premières lignes → vérification (simulation complète, sans rien
 * enregistrer) → « Importer », enregistré en une seule opération (tout ou rien).
 *
 * La vérification est possible en version gratuite (pour voir ce qui serait
 * importé) ; l'import lui-même est réservé à Stockly Pro.
 */
import { useMemo, useState } from 'react';
import { ActivityIndicator, Alert as RNAlert, Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Alert, Btn, Card, Chip, H2, Muted, Screen } from '../components/ui';
import { ProNotice, alertProFeature } from '../components/ProNotice';
import { colors } from '../constants/theme';
import {
  IMPORT_FIELDS,
  ImportFileError,
  autoMap,
  buildRecords,
  cleanCell,
  columnLetter,
  detectHeader,
  readImportFile,
  type ImportField,
  type ImportFile,
  type ImportMapping,
} from '../data/importExcel';
import { pickImportFile } from '../data/importPick';
import { fmtCount, importInventory, isProActive, type ImportIssue, type ImportSummary } from '../data/store';

const PREVIEW_ROWS = 3;
const MAX_LISTED = 40;

/** Laisse l'indicateur d'activité s'afficher avant un calcul synchrone. */
const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

export default function ImportScreen() {
  const [file, setFile] = useState<ImportFile | null>(null);
  const [fileName, setFileName] = useState('');
  const [sheetIdx, setSheetIdx] = useState(0);
  const [headerIdx, setHeaderIdx] = useState(0);
  const [detected, setDetected] = useState(true);
  const [mapping, setMapping] = useState<ImportMapping>({});
  const [editing, setEditing] = useState<ImportField | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pro = isProActive();

  const rows = file?.sheets[sheetIdx]?.rows ?? [];
  const header = rows[headerIdx]?.cells ?? [];
  const columnCount = Math.max(header.length, ...rows.slice(headerIdx, headerIdx + 20).map((r) => r.cells.length), 0);
  const dataRows = Math.max(0, rows.length - headerIdx - 1);

  const columnLabel = (c: number) => {
    const h = cleanCell(header[c]);
    return `${columnLetter(c)}${h ? ` · ${h.length > 28 ? `${h.slice(0, 27)}…` : h}` : ''}`;
  };

  const selectSheet = (f: ImportFile, idx: number) => {
    const det = detectHeader(f.sheets[idx]?.rows ?? []);
    setSheetIdx(idx);
    setHeaderIdx(det.headerIndex);
    setMapping(det.mapping);
    setDetected(det.detected);
    setSummary(null);
    setEditing(null);
  };

  const choose = async () => {
    setError(null);
    const picked = await pickImportFile();
    if (!picked.ok) {
      if (!picked.cancelled) setError(picked.error);
      return;
    }
    setBusy('Lecture du fichier…');
    await nextFrame();
    try {
      const f = readImportFile(picked.file.bytes, picked.file.name);
      // Première feuille qui contient une ligne d'en-tête reconnue (sinon la première).
      const idx = Math.max(0, f.sheets.findIndex((s) => detectHeader(s.rows).detected));
      setFile(f);
      setFileName(picked.file.name);
      selectSheet(f, idx);
    } catch (e) {
      setFile(null);
      setError(e instanceof ImportFileError ? e.message : "Le fichier n'a pas pu être lu.");
      if (!(e instanceof ImportFileError)) console.warn('[import] Lecture impossible.', e);
    } finally {
      setBusy(null);
    }
  };

  const changeHeader = (delta: number) => {
    const next = Math.min(Math.max(0, headerIdx + delta), Math.max(0, rows.length - 1));
    setHeaderIdx(next);
    setMapping(autoMap(rows[next]?.cells ?? []));
    setSummary(null);
  };

  const setField = (field: ImportField, col: number | undefined) => {
    setMapping((m) => {
      const next: ImportMapping = { ...m };
      // Une colonne ne sert qu'à un champ : elle est retirée de l'autre.
      if (col !== undefined) for (const f of Object.keys(next) as ImportField[]) if (next[f] === col) delete next[f];
      if (col === undefined) delete next[field];
      else next[field] = col;
      return next;
    });
    setEditing(null);
    setSummary(null);
  };

  const canAnalyze = mapping.name !== undefined && dataRows > 0;

  const records = () => buildRecords(rows, headerIdx, mapping, file?.kind ?? 'csv', file?.date1904 ?? false);

  const analyze = async () => {
    setBusy('Vérification…');
    await nextFrame();
    try {
      const res = importInventory(records(), { dryRun: true });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setError(null);
      setSummary(res.summary);
    } finally {
      setBusy(null);
    }
  };

  const doImport = async () => {
    if (!isProActive()) {
      alertProFeature("L'import Excel");
      return;
    }
    setBusy('Import en cours…');
    await nextFrame();
    let res: ReturnType<typeof importInventory>;
    try {
      res = importInventory(records());
    } finally {
      setBusy(null);
    }
    if (!res.ok) {
      if (res.pro) alertProFeature("L'import Excel");
      else RNAlert.alert('Import impossible', res.error);
      if (res.summary) setSummary(res.summary);
      return;
    }
    const s = res.summary;
    const created = s.serializedItemsCreated + s.quantityItemsCreated;
    RNAlert.alert(
      'Import terminé',
      [
        `${fmtCount(created, 'article créé', 'articles créés')}`,
        `${fmtCount(s.unitsAdded, 'appareil ajouté', 'appareils ajoutés')}`,
        s.skipped.length > 0 ? `${fmtCount(s.skipped.length, 'ligne ignorée', 'lignes ignorées')}` : '',
      ].filter(Boolean).join('\n'),
      [{ text: 'OK', onPress: () => (router.canGoBack() ? router.back() : router.navigate('/articles')) }]
    );
  };

  const previewRows = rows.slice(headerIdx + 1, headerIdx + 1 + PREVIEW_ROWS);
  const mappedFields = IMPORT_FIELDS.filter((f) => mapping[f.key] !== undefined);

  const toImport = summary ? summary.serializedItemsCreated + summary.quantityItemsCreated + summary.unitsAdded : 0;

  return (
    <Screen hasHeader>
      {!pro && (
        <ProNotice message="L'import Excel est réservé à Stockly Pro. Vous pouvez choisir un fichier et vérifier ce qui serait importé." />
      )}

      {!file && (
        <Card style={{ gap: 10 }}>
          <H2>Importer votre inventaire</H2>
          <Muted style={{ fontSize: 14, lineHeight: 20 }}>
            Fichier Excel (.xlsx) ou CSV, avec une ligne d'en-tête. Colonnes reconnues : Article (ou Désignation, Modèle),
            Catégorie, Numéro de série, IMEI, IMEI 2, Statut, Attribué à, Date de réception, Note, Quantité, SKU, Code-barres, Seuil.
          </Muted>
          <Muted style={{ fontSize: 14, lineHeight: 20 }}>
            Une ligne avec un numéro de série ajoute un appareil ; une ligne sans numéro de série crée un article suivi en quantité.
            Rien n'est enregistré avant la vérification et votre confirmation.
          </Muted>
        </Card>
      )}

      {error && <Alert message={error} />}

      {busy ? (
        <View style={{ alignItems: 'center', gap: 10, paddingVertical: 24 }} accessibilityLiveRegion="polite">
          <ActivityIndicator color={colors.primary} />
          <Muted>{busy}</Muted>
        </View>
      ) : (
        <Btn
          title={file ? 'Choisir un autre fichier' : 'Choisir un fichier'}
          variant={file ? 'outline' : 'primary'}
          onPress={() => { void choose(); }}
          accessibilityHint="Ouvre le sélecteur de fichiers (Excel ou CSV)"
        />
      )}

      {file && !busy && (
        <>
          <Card style={{ gap: 10 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }} numberOfLines={2}>{fileName}</Text>
            <Muted>
              {file.kind === 'xlsx' ? 'Classeur Excel' : `CSV (séparateur « ${file.delimiter === '\t' ? 'tabulation' : file.delimiter} »)`}
              {' · '}{fmtCount(dataRows, 'ligne de données', 'lignes de données')}
            </Muted>
            {file.notice && (
              <Text accessibilityLiveRegion="polite" style={{ fontSize: 13, color: colors.warnText, backgroundColor: colors.warnBg, borderRadius: 8, padding: 10 }}>
                {file.notice}
              </Text>
            )}
            {file.sheets.length > 1 && (
              <View style={{ gap: 6 }}>
                <Muted>Feuille</Muted>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {file.sheets.map((s, i) => (
                    <Chip key={`${i}-${s.name}`} label={s.name} active={i === sheetIdx} onPress={() => selectSheet(file, i)} />
                  ))}
                </View>
              </View>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ flex: 1, fontSize: 14, color: colors.text }}>
                Ligne d'en-tête : {rows[headerIdx]?.n ?? '—'}
              </Text>
              <Chip label="‹" accessibilityLabel="Ligne d'en-tête précédente" onPress={() => changeHeader(-1)} />
              <Chip label="›" accessibilityLabel="Ligne d'en-tête suivante" onPress={() => changeHeader(1)} />
            </View>
            {!detected && (
              <Muted style={{ color: colors.warnText }}>
                Aucune ligne d'en-tête reconnue : choisissez la ligne d'en-tête et la colonne de chaque champ.
              </Muted>
            )}
          </Card>

          <H2>Colonnes</H2>
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {IMPORT_FIELDS.map((f, i) => {
              const col = mapping[f.key];
              const open = editing === f.key;
              return (
                <View key={f.key} style={{ borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.line }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${f.label} : ${col === undefined ? 'ignoré' : `colonne ${columnLabel(col)}`}`}
                    accessibilityHint="Choisir la colonne de ce champ"
                    accessibilityState={{ expanded: open }}
                    onPress={() => setEditing(open ? null : f.key)}
                    style={{ minHeight: 52, paddingHorizontal: 16, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10 }}
                  >
                    <Text style={{ width: 130, fontSize: 14, fontWeight: '600', color: colors.text }}>
                      {f.label}{f.key === 'name' ? ' *' : ''}
                    </Text>
                    <Text style={{ flex: 1, fontSize: 14, color: col === undefined ? colors.muted : colors.primary }} numberOfLines={1}>
                      {col === undefined ? 'Ignorer' : columnLabel(col)}
                    </Text>
                  </Pressable>
                  {open && (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingBottom: 12 }}>
                      <Chip label="Ignorer" active={col === undefined} onPress={() => setField(f.key, undefined)} />
                      {Array.from({ length: columnCount }, (_, c) => (
                        <Chip key={c} label={columnLabel(c)} active={col === c} onPress={() => setField(f.key, c)} />
                      ))}
                    </View>
                  )}
                </View>
              );
            })}
          </Card>
          {mapping.name === undefined && <Muted style={{ color: colors.warnText }}>Choisissez la colonne « Article » (nom de l'article).</Muted>}

          {previewRows.length > 0 && mappedFields.length > 0 && (
            <>
              <H2>Aperçu</H2>
              <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ gap: 10 }}>
                {previewRows.map((r) => (
                  <Card key={r.n} style={{ width: 260, gap: 4, padding: 12 }}>
                    <Muted style={{ fontWeight: '600' }}>Ligne {r.n}</Muted>
                    {mappedFields.map((f) => {
                      const v = cleanCell(r.cells[mapping[f.key]!]);
                      return (
                        <Text key={f.key} style={{ fontSize: 13, color: colors.text }} numberOfLines={2}>
                          <Text style={{ color: colors.muted }}>{f.label} : </Text>{v || '—'}
                        </Text>
                      );
                    })}
                  </Card>
                ))}
              </ScrollView>
            </>
          )}

          {!summary && (
            <Btn
              title="Vérifier l'import"
              disabled={!canAnalyze}
              onPress={() => { void analyze(); }}
              accessibilityHint="Simule l'import sans rien enregistrer et affiche le résultat"
            />
          )}

          {summary && (
            <>
              <H2>Résultat de la vérification</H2>
              <Card style={{ gap: 6 }}>
                <SummaryLine label="Articles à créer" value={summary.serializedItemsCreated + summary.quantityItemsCreated}
                  detail={`${summary.serializedItemsCreated} par numéro de série · ${summary.quantityItemsCreated} en quantité`} />
                <SummaryLine label="Articles existants complétés" value={summary.itemsMatched} />
                <SummaryLine label="Appareils à ajouter" value={summary.unitsAdded} />
                <SummaryLine label="Articles déjà présents (inchangés)" value={summary.existing.length} />
                <SummaryLine label="Lignes ignorées" value={summary.skipped.length} warn={summary.skipped.length > 0} />
                <SummaryLine label="Avertissements" value={summary.warnings.length} warn={summary.warnings.length > 0} />
              </Card>
              {summary.limitSkipped > 0 && (
                <ProNotice message={`${fmtCount(summary.limitSkipped, 'ligne dépasse', 'lignes dépassent')} les limites de la version gratuite (50 articles, 100 appareils). Stockly Pro n'a aucune limite.`} />
              )}
              <IssueList title="Lignes ignorées" issues={summary.skipped} />
              <IssueList title="Avertissements" issues={summary.warnings} />
              <IssueList title="Articles déjà présents" issues={summary.existing} />
              <Btn
                title={toImport === 0 ? 'Rien à importer' : pro ? 'Importer' : 'Importer · Pro'}
                disabled={toImport === 0}
                onPress={() => { void doImport(); }}
                accessibilityHint="Enregistre l'import en une seule fois"
              />
              <Btn title="Revérifier" variant="outline" onPress={() => { void analyze(); }} />
            </>
          )}
        </>
      )}
    </Screen>
  );
}

function SummaryLine({ label, value, detail, warn }: { label: string; value: number; detail?: string; warn?: boolean }) {
  return (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 14, color: colors.text }}>{label}</Text>
        <Text style={{ fontSize: 15, fontWeight: '700', color: warn ? colors.warnText : colors.text }}>{value}</Text>
      </View>
      {detail && <Muted>{detail}</Muted>}
    </View>
  );
}

function IssueList({ title, issues }: { title: string; issues: readonly ImportIssue[] }) {
  const [all, setAll] = useState(false);
  const shown = useMemo(() => (all ? issues : issues.slice(0, MAX_LISTED)), [all, issues]);
  if (issues.length === 0) return null;
  return (
    <Card style={{ gap: 6 }}>
      <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>{title} ({issues.length})</Text>
      {shown.map((it, i) => (
        <Text key={`${it.row}-${i}`} style={{ fontSize: 13, color: colors.text }}>
          <Text style={{ fontWeight: '600' }}>Ligne {it.row} : </Text>{it.message}
        </Text>
      ))}
      {issues.length > shown.length && (
        <Pressable accessibilityRole="button" onPress={() => setAll(true)} style={{ minHeight: 40, justifyContent: 'center' }}>
          <Text style={{ fontSize: 13, color: colors.primary, fontWeight: '600' }}>Tout afficher ({issues.length - shown.length} de plus)</Text>
        </Pressable>
      )}
    </Card>
  );
}
