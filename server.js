const express = require('express');
const cors = require('cors');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

function obtenirCleAPI(req) {
    const cleEleve = req.headers['x-custom-api-key'];
    if (cleEleve && cleEleve.trim().startsWith("AIzaSy")) return cleEleve.trim();
    return process.env.GEMINI_API_KEY;
}

const attendre = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function appelerGeminiAvecSecours(contents, modelesPrioritaires, apiKey) {
    const listeAtester = [...new Set(modelesPrioritaires)];
    let journalErreurs = [];

    for (const modele of listeAtester) {
        for (let tentative = 1; tentative <= 2; tentative++) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${modele}:generateContent?key=${apiKey}`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: contents,
                        generationConfig: { responseMimeType: "application/json" }
                    })
                });

                const data = await response.json();
                if (data.error) {
                    const code = data.error.code || response.status;
                    if ((code === 503 || code === 429) && tentative === 1) {
                        await attendre(1500);
                        continue;
                    }
                    journalErreurs.push(`${modele}: [Code ${code}] ${data.error.message}`);
                    break;
                }

                if (data.candidates && data.candidates[0].content.parts[0].text) {
                    let texte = data.candidates[0].content.parts[0].text;
                    texte = texte.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
                    return JSON.parse(texte);
                }
            } catch (err) {
                journalErreurs.push(`${modele}: ${err.message}`);
                break;
            }
        }
    }
    throw new Error("Échec des modèles testés :\n" + journalErreurs.join("\n"));
}

// 1. ENDPOINT ANALYSE PDF (COURS & BLOCS) - EXCLUSIVEMENT GEMINI 3.8 FLASH
app.post('/api/analyser-pdf', upload.single('pdf'), async (req, res) => {
    try {
        const apiKey = obtenirCleAPI(req);
        if (!apiKey) return res.status(500).json({ error: "Clé Gemini absente." });
        if (!req.file) return res.status(400).json({ error: "Aucun fichier PDF reçu." });

        const pdfBase64 = req.file.buffer.toString('base64');

        const prompt = `
Tu es un professeur de FLE pour apprenants coréens. Analyse ce document et structure-le en modules pédagogiques :
RÈGLE CRUCIALE : Chaque phrase à trous doit être ENTIÈRE jusqu'au point final. Si plusieurs verbes à conjuguer, conserve toute la phrase avec ses multiples "____".

Structure JSON :
{
  "titre": "Titre de la leçon",
  "bloc_cours": {
    "titre": "Cours de Grammaire",
    "slides": [ { "numero": 1, "titre": "Titre fiche", "contenu_coreen": "Explications..." } ]
  },
  "blocs_exercices": [
    {
      "id": "exo_1",
      "titre": "Titre exercice",
      "consigne": "Consigne",
      "questions": [ { "q": "Phrase avec ____ (verbe)" } ]
    }
  ]
}
`;
        const contents = [{ parts: [{ text: prompt }, { inline_data: { mime_type: "application/pdf", data: pdfBase64 } }] }];
        // STRICTEMENT GEMINI 3.8 FLASH (aucun repli autorisé sur ce point crucial)
        const resultatJson = await appelerGeminiAvecSecours(contents, ['gemini-3.8-flash'], apiKey);
        res.json(resultatJson);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. ENDPOINT AJUSTEMENT PDF - GEMINI 3.8 FLASH
app.post('/api/ajuster-contenu', async (req, res) => {
    try {
        const apiKey = obtenirCleAPI(req);
        const { contenuActuel, instruction } = req.body;

        const prompt = `
Tu es un professeur de FLE pour élèves coréens. Voici le cours actuel :
${JSON.stringify(contenuActuel, null, 2)}
INSTRUCTION DU PROFESSEUR : "${instruction}"
Renvoie UNIQUEMENT le JSON mis à jour :
`;
        const contents = [{ parts: [{ text: prompt }] }];
        const resultatJson = await appelerGeminiAvecSecours(contents, ['gemini-3.8-flash'], apiKey);
        res.json(resultatJson);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. ENDPOINT EMMA : EXCLUSIVEMENT LES MODÈLES LITE (500 RPD) - JAMAIS EN FLASH NORMAL
app.post('/api/corriger-emma', async (req, res) => {
    try {
        const apiKey = obtenirCleAPI(req);
        if (!apiKey) return res.status(500).json({ error: "Clé Gemini absente." });

        const { question, reponseEleve, langue } = req.body;
        const langCode = (langue || 'fr').toLowerCase();

        let consigneLangue = "Donne toutes tes explications grammaticales en Français.";
        let nomLangue = "français";
        if (langCode === 'ko') {
            consigneLangue = "Rédige TOUTES les explications pédagogiques (ce qui est bien, fautes, améliorations) en CORÉEN (한국어). Traduis aussi la réponse amicale et la phrase corrigée en coréen.";
            nomLangue = "coréen";
        } else if (langCode === 'en') {
            consigneLangue = "Rédige TOUTES les explications pédagogiques (ce qui est bien, fautes, améliorations) en ANGLAIS. Traduis aussi la réponse amicale et la phrase corrigée en anglais.";
            nomLangue = "anglais";
        }

        if (!reponseEleve || !reponseEleve.trim()) {
            return res.json({
                reponse_amicale: "Tu n'as rien écrit ! N'aie pas peur d'essayer. 😊",
                traduction_reponse: langCode === 'ko' ? "아무것도 쓰지 않았어요! 두려워하지 말고 시도해 보세요. 😊" : (langCode === 'en' ? "You wrote nothing! Don't be afraid to try. 😊" : ""),
                ce_qui_est_bien: langCode === 'ko' ? "아직 없음." : "Rien pour l'instant.",
                les_fautes: langCode === 'ko' ? "답변이 비어 있습니다." : "La réponse est vide.",
                phrase_corrigee: "Écris une phrase complète.",
                traduction_phrase_corrigee: langCode === 'ko' ? "완전한 문장을 작성하세요." : (langCode === 'en' ? "Write a full sentence." : ""),
                ameliorations: langCode === 'ko' ? "직접 작성해 보세요!" : "Lance-toi !"
            });
        }

        const prompt = `
Tu es Emma, une amie française bienveillante (A2-B1).
Tu dialogues avec un apprenant de français.

Question posée : "${question}"
Phrase écrite par l'élève : "${reponseEleve}"
Langue cible pour les explications de l'élève : ${nomLangue}.

[INSTRUCTIONS DE LANGUE]
${consigneLangue}
- La réponse amicale d'Emma doit TOUJOURS être en Français naturel et simple (A2-B1).
- Si la langue n'est pas le français, donne la traduction de cette réponse dans le champ "traduction_reponse".
- Donne la traduction de la phrase corrigée dans "traduction_phrase_corrigee".

[INSTRUCTIONS DE CORRECTION - ANTI-HALLUCINATION STRICTE]
1. Regarde VRAIMENT la phrase écrite par l'élève.
2. Si la 1ère lettre est une majuscule -> INTERDICTION de dire qu'elle manque.
3. Si le dernier caractère est un point (.) ou point d'interrogation (?) -> INTERDICTION de dire qu'il manque.
4. Ne corrige que les VRAIES fautes (grammaire, conjugaison, orthographe, vocabulaire).
5. Si la phrase est correcte, indique clairement qu'il n'y a pas de faute.

Renvoie UNIQUEMENT un objet JSON sous ce format :
{
  "reponse_amicale": "Réponse en français...",
  "traduction_reponse": "Traduction de la réponse en ${nomLangue} (laisse vide si langue == fr)",
  "ce_qui_est_bien": "Explications dans la langue choisie...",
  "les_fautes": "Fautes expliquées dans la langue choisie...",
  "phrase_corrigee": "Phrase correcte en français...",
  "traduction_phrase_corrigee": "Traduction de la phrase corrigée en ${nomLangue} (laisse vide si langue == fr)",
  "ameliorations": "Conseils dans la langue choisie..."
}
`;

        const contents = [{ parts: [{ text: prompt }] }];

        // UNIQUEMENT LES MODÈLES LITE (500 RPD) - AUCUN FLASH NORMAL POUR NE PAS GASPILLER LE QUOTA DE 20 RPD
        const modelesLiteUniquement = [
            'gemini-3.5-flash-lite',
            'gemini-3.1-flash-lite',
            'gemini-2.5-flash-lite'
        ];

        const resultatJson = await appelerGeminiAvecSecours(contents, modelesLiteUniquement, apiKey);
        res.json(resultatJson);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur French API actif sur le port ${PORT}`));
