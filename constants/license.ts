/**
 * Texte affiché dans Profil › Stockly Pro pour expliquer comment acheter une
 * licence (numéro WhatsApp, mobile money…). À REMPLACER avant la mise en vente.
 *
 * Il est ici (JavaScript) et non dans app.json : `expo.extra` fait partie du
 * fingerprint (`runtimeVersion`), si bien qu'une modification dans app.json
 * exigerait un nouveau build, alors qu'ici une mise à jour OTA (EAS Update)
 * suffit. Tant que le texte commence par « A_REMPLACER », une phrase générique
 * est affichée à la place.
 */
export const LICENSE_CONTACT =
  "A_REMPLACER : comment acheter Stockly Pro (ex. « Appelez ou écrivez sur WhatsApp au +XXX XX XX XX XX. Paiement par mobile money (Orange Money, Wave, MTN MoMo…) au même numéro, en indiquant le nom de votre société et le code de ce téléphone. Vous recevrez le code d'activation par WhatsApp. »)";
