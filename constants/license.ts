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

/**
 * Contrôle de licence Stockly Pro actif ou non.
 *
 * `false` (actuellement) : tous les téléphones fonctionnent comme en Pro —
 * aucune limite de 50 articles / 100 appareils, import / export Excel et
 * export Jira Assets ouverts, aucune invitation « Découvrir Stockly Pro », et
 * la section « Stockly Pro » de Profil est masquée. Le code de licence reste
 * en place : passez à `true` pour le réactiver. Valeur JavaScript : une mise à
 * jour OTA (EAS Update) suffit pour la changer, sans nouveau build.
 */
export const LICENSE_ENFORCED: boolean = false;
