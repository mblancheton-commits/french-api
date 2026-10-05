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

// 1. ENDPOINT ANALYSE PDF (COURS, POINTS CLÉS TRILINGUES, QUIZ THÉORIQUE & EXERCICES) - GEMINI 3.8 FLASH EXCLUSIF
app.post('/api/analyser-pdf', upload.single('pdf'), async (req, res) => {
    try {
        const apiKey = obtenirCleAPI(req);
        if (!apiKey) return res.status(500).json({ error: "Clé Gemini absente." });
        if (!req.file) return res.status(400).json({ error: "Aucun fichier PDF reçu." });

        const pdfBase64 = req.file.buffer.toString('base64');

        const prompt = `
Tu es un professeur expert de Français Langue Étrangère (FLE). Analyse ce document pédagogique en profondeur et structure-le rigoureusement.

Tu dois impérativement générer :
1. "points_importants" : Les notions clés et règles essentielles du cours, rédigées en TROIS LANGUES (français, anglais, coréen).
2. "bloc_cours" : Les fiches théoriques du cours avec explications claires et exemples.
3. "quiz_theorique" : Un questionnaire de compréhension théorique (3 à 5 questions) pour valider l'assimilation des règles du cours avant de faire les exercices pratiques. Chaque question, ses options et son explication doivent être fournies dans les TROIS LANGUES.
4. "blocs_exercices" : Les exercices pratiques d'application. RÈGLE CRUCIALE : Chaque phrase à trous doit être ENTIÈRE jusqu'au point final. Conserve toute la phrase avec ses "____".

Structure JSON STRICTE à renvoyer :
{
  "titre": "Titre de la leçon",
  "points_importants": {
    "fr": ["Point clé 1...", "Point clé 2..."],
    "en": ["Key point 1...", "Key point 2..."],
    "ko": ["핵심 포인트 1...", "핵심 포인트 2..."]
  },
  "bloc_cours": {
    "titre": "Cours théorique",
    "slides": [
      {
        "numero": 1,
        "titre": "Titre de la section",
        "contenu_fr": "Explications en français...",
        "contenu_en": "Explanations in English...",
        "contenu_ko": "한국어 설명..."
      }
    ]
  },
  "quiz_theorique": {
    "titre": "Quiz de vérification du cours",
    "questions": [
      {
        "id": 1,
        "question": {
          "fr": "Question sur la règle de grammaire en français ?",
          "en": "Question in English ?",
          "ko": "한국어 질문 ?"
        },
        "options": {
          "fr": ["Option A", "Option B", "Option C"],
          "en": ["Option A", "Option B", "Option C"],
          "ko": ["보기 A", "보기 B", "보기 C"]
        },
        "reponse_correcte_index": 0,
        "explication": {
          "fr": "Explication de la réponse...",
          "en": "Explanation...",
          "ko": "정답 해설..."
        }
      }
    ]
  },
  "blocs_exercices": [
    {
      "id": "exo_1",
      "titre": "Exercice d'application",
      "consigne": "Complétez les phrases.",
      "questions": [
        { "q": "Phrase modèle avec ____ pour le mot à trouver." }
      ]
    }
  ]
}
`;
        const contents = [{ parts: [{ text: prompt }, { inline_data: { mime_type: "application/pdf", data: pdfBase64 } }] }];
        const resultatJson = await appelerGeminiAvecSecours(contents, ['gemini-3.8-flash'], apiKey);
        res.json(resultatJson);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. ENDPOINT AJUSTEMENT PDF
app.post('/api/ajuster-contenu', async (req, res) => {
    try {
        const apiKey = obtenirCleAPI(req);
        if (!apiKey) return res.status(500).json({ error: "Clé Gemini absente." });
        const { contenuActuel, instruction } = req.body;

        const prompt = `
Tu es un professeur expert de FLE. Voici le cours complet actuellement généré (au format JSON) :
${JSON.stringify(contenuActuel, null, 2)}

INSTRUCTION PRÉCISE DU PROFESSEUR :
"${instruction}"

RÈGLES IMPÉRATIVES :
1. Applique scrupuleusement la demande du professeur.
2. Conserve TOUJOURS la structure JSON complète :
   - "titre"
   - "points_importants" (avec ses sous-clés "fr", "en", "ko")
   - "bloc_cours" (avec ses slides et contenus "contenu_fr", "contenu_en", "contenu_ko")
   - "quiz_theorique" (questions, options en 3 langues, reponse_correcte_index, explication en 3 langues)
   - "blocs_exercices" (avec phrases complètes et trous "____")
3. Renvoie UNIQUEMENT le JSON mis à jour, sans aucun texte autour.
`;
        const contents = [{ parts: [{ text: prompt }] }];
        const resultatJson = await appelerGeminiAvecSecours(contents, ['gemini-3.8-flash'], apiKey);
        res.json(resultatJson);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. ENDPOINT EMMA : EXCLUSIVEMENT LES MODÈLES LITE (500 RPD)
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

// 4. ENDPOINT GÉNÉRATION D'ENTRAÎNEMENT (FLASH LITE)
app.post('/api/generer-entrainement', async (req, res) => {
    try {
        const apiKey = obtenirCleAPI(req);
        if (!apiKey) return res.status(500).json({ error: "Clé Gemini absente." });

        const { titreSource, contexteExemples, format, nbPhrases } = req.body;
        const nombre = Math.min(Math.max(parseInt(nbPhrases) || 5, 3), 15);
        const typeFormat = format === 'text' ? 'text' : 'select';

        const prompt = `
Tu es un professeur de FLE créant des exercices d'entraînement pour un élève.
Devoir modèle source : "${titreSource}"
Exemples de contenu : ${JSON.stringify(contexteExemples || []).slice(0, 800)}

Crée exactement ${nombre} nouvelles phrases d'entraînement sur le MÊME sujet ou thème grammatical.
RÈGLES :
1. Chaque phrase doit comporter un trou marqué par "____".
2. Le trou correspond à la difficulté travaillée.
${typeFormat === 'select' ? '- Donne 3 ou 4 options de choix dont la bonne réponse.' : '- Précise la ou les réponses acceptées.'}

Structure JSON :
{
  "titre": "Entraînement : ${titreSource}",
  "phrases": [
    {
      "q": "Phrase modèle avec ____.",
      "type": "${typeFormat}",
      ${typeFormat === 'select' ? '"options": ["choix1", "choix2", "choix3"],' : ''}
      "a": ["bonne_reponse"]
    }
  ]
}
`;

        const contents = [{ parts: [{ text: prompt }] }];
        const modelesLite = [
            'gemini-3.5-flash-lite',
            'gemini-3.1-flash-lite',
            'gemini-2.5-flash-lite'
        ];

        const resultatJson = await appelerGeminiAvecSecours(contents, modelesLite, apiKey);
        res.json(resultatJson);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur French API actif sur le port ${PORT}`));
