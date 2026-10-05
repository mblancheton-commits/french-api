const express = require('express');
const cors = require('cors');
const multer = require('multer');

let pdfParse = require('pdf-parse');
if (typeof pdfParse !== 'function' && pdfParse.default) {
    pdfParse = pdfParse.default;
}

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

function obtenirCleGemini(req) {
    const cle = req.headers['x-custom-api-key'];
    if (cle && cle.trim().startsWith("AIzaSy")) return cle.trim();
    return process.env.GEMINI_API_KEY;
}

function obtenirCleNanoGPT(req) {
    const cleHeader = req.headers['x-nanogpt-key'];
    if (cleHeader && cleHeader.trim()) return cleHeader.trim();
    return process.env.NANOGPT_API_KEY;
}

// --- APPEL STRICT GOOGLE GEMINI ---
async function appelerGeminiStrict(contents, model, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: contents,
            generationConfig: { 
                responseMimeType: "application/json",
                maxOutputTokens: 16000
            }
        })
    });

    const data = await response.json();
    if (data.error) throw new Error(`[Gemini] ${data.error.message || JSON.stringify(data.error)}`);

    if (data.candidates && data.candidates[0].content && data.candidates[0].content.parts[0].text) {
        let texte = data.candidates[0].content.parts[0].text;
        texte = texte.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        return JSON.parse(texte);
    }
    throw new Error("Réponse vide reçue de Gemini.");
}

// --- APPEL STRICT NANOGPT ---
async function appelerNanoGPTStrict(messages, model, apiKey) {
    if (!apiKey) throw new Error("Clé API NanoGPT manquante.");

    const response = await fetch("https://nano-gpt.com/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "x-api-key": apiKey
        },
        body: JSON.stringify({
            model: model,
            messages: messages,
            temperature: 0.1,
            max_tokens: 16000
        })
    });

    const data = await response.json();
    if (data.error) throw new Error(`[NanoGPT - ${model}] ${data.error.message || JSON.stringify(data.error)}`);

    if (data.choices && data.choices[0] && data.choices[0].message) {
        let texte = data.choices[0].message.content || "";

        // Nettoyer les balises thinking <think>...</think>
        texte = texte.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        texte = texte.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

        const premierCrochet = texte.indexOf('{');
        const dernierCrochet = texte.lastIndexOf('}');
        if (premierCrochet !== -1 && dernierCrochet !== -1) {
            texte = texte.substring(premierCrochet, dernierCrochet + 1);
        }

        return JSON.parse(texte);
    }
    throw new Error(`Aucune réponse exploitable renvoyée par ${model}.`);
}

// 1. ENDPOINT ANALYSE PDF (AVEC SAUT DE LIGNE À CHAQUE PHRASE DU COURS)
app.post('/api/analyser-pdf', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "Aucun fichier PDF reçu." });

        const modelChoisi = req.headers['x-model-choice'] || 'deepseek/deepseek-v4.1-flash:thinking';
        
        const promptStructure = `
Tu es un professeur expert de FLE. Analyse ce document et structure-le rigoureusement.

RÈGLE DE MISE EN PAGE DU COURS (CRUCIALE) :
- Dans chaque fiche de cours (dans "contenu_fr", "contenu_en" et "contenu_ko"), tu as l'OBLIGATION de faire un saut de ligne double (deux retours à la ligne: \\n\\n) APRÈS CHAQUE PHRASE OU EXEMPLE.
- Interdiction absolue de faire des paragraphes compacts ou des blocs de texte denses. Chaque explication, règle ou phrase d'exemple doit être isolée sur sa propre ligne avec un espacement vertical aéré.

RÈGLE D'EXHAUSTIVITÉ DES EXERCICES :
- Tu DOIS inclure ABSOLUMENT TOUTES LES PHRASES d'exercices présentes dans le document, de la première à la toute dernière.
- Chaque phrase à trous doit être ENTIÈRE, conservée du premier mot jusqu'au point final, avec ses trous "____".

Structure JSON STRICTE à respecter :
{
  "titre": "Titre exact de la leçon",
  "bloc_cours": {
    "titre": "Cours théorique",
    "slides": [
      {
        "numero": 1,
        "titre": "Titre de la section",
        "contenu_fr": "Première phrase de cours explicative.\\n\\nDeuxième phrase avec une règle précise.\\n\\nExemple : Je vais manger une pomme.\\n\\nAutre exemple : Nous allons partir bientôt.",
        "contenu_en": "First explanatory sentence.\\n\\nSecond sentence detailing the rule.\\n\\nExample: I am going to eat an apple.\\n\\nAnother example: We are leaving soon.",
        "contenu_ko": "첫 번째 문법 설명 문장입니다.\\n\\n두 번째 구체적인 규칙 설명 문장입니다.\\n\\n예문: Je vais manger une pomme.\\n\\n다른 예문: Nous allons partir bientôt."
      }
    ]
  },
  "points_importants": {
    "fr": ["Point clé 1...", "Point clé 2..."],
    "en": ["Key point 1...", "Key point 2..."],
    "ko": ["핵심 포인트 1...", "핵심 포인트 2..."]
  },
  "quiz_theorique": {
    "titre": "Quiz de vérification du cours",
    "questions": [
      {
        "id": 1,
        "question": {
          "fr": "Question sur la règle en français ?",
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
          "fr": "Explication...",
          "en": "Explanation...",
          "ko": "정답 해설..."
        }
      }
    ]
  },
  "blocs_exercices": [
    {
      "id": "exo_1",
      "titre": "Titre de l'exercice 1",
      "consigne": "Consigne complète",
      "questions": [
        { "q": "TOUTES les phrases de l'exercice 1 sans en omettre une seule avec ____." }
      ]
    },
    {
      "id": "exo_2",
      "titre": "Titre de l'exercice 2",
      "consigne": "Consigne complète",
      "questions": [
        { "q": "TOUTES les phrases de l'exercice 2 sans en omettre une seule avec ____." }
      ]
    }
  ]
}
`;

        if (modelChoisi.startsWith("gemini")) {
            const apiKey = obtenirCleGemini(req);
            if (!apiKey) return res.status(500).json({ error: "Clé Gemini absente." });
            const pdfBase64 = req.file.buffer.toString('base64');
            const contents = [{ parts: [{ text: promptStructure }, { inline_data: { mime_type: "application/pdf", data: pdfBase64 } }] }];
            const resultat = await appelerGeminiStrict(contents, modelChoisi, apiKey);
            return res.json(resultat);
        }

        const apiKeyNano = obtenirCleNanoGPT(req);
        if (!apiKeyNano) return res.status(500).json({ error: "Clé NanoGPT absente. Veuillez la renseigner." });

        let texteExtrait = "";
        try {
            const fnParser = typeof pdfParse === 'function' ? pdfParse : (pdfParse.default || pdfParse);
            const donneesPdf = await fnParser(req.file.buffer);
            texteExtrait = (donneesPdf && donneesPdf.text) ? donneesPdf.text : "";
        } catch(eParser) {
            throw new Error("Impossible de lire le texte du PDF : " + eParser.message);
        }

        const messages = [
            { 
                role: "system", 
                content: "Tu es un professeur de FLE rigoureux. Dans les fiches de cours, tu mets impérativement un double saut de ligne (\\n\\n) après chaque phrase. Tu réponds STRICTEMENT au format JSON." 
            },
            { 
                role: "user", 
                content: `${promptStructure}\n\n[CONTENU DU DOCUMENT PDF SOURCE] :\n${texteExtrait}` 
            }
        ];

        const resultat = await appelerNanoGPTStrict(messages, modelChoisi, apiKeyNano);
        res.json(resultat);

    } catch (err) {
        console.error("Erreur analyser-pdf :", err);
        res.status(500).json({ error: err.message });
    }
});

// 2. ENDPOINT AJUSTEMENT CONTENU
app.post('/api/ajuster-contenu', async (req, res) => {
    try {
        const { contenuActuel, instruction } = req.body;
        const modelChoisi = req.headers['x-model-choice'] || 'deepseek/deepseek-v4.1-flash:thinking';

        const prompt = `
Tu es un professeur de FLE. Voici le cours actuel en JSON :
${JSON.stringify(contenuActuel, null, 2)}

INSTRUCTION DU PROFESSEUR :
"${instruction}"

RÈGLES :
1. Dans chaque fiche de cours, sépare CHAQUE phrase par un double saut de ligne (\\n\\n).
2. Conserve impérativement TOUTES les phrases des exercices.
Renvoie STRICTEMENT le JSON complet mis à jour :
`;

        if (modelChoisi.startsWith("gemini")) {
            const apiKey = obtenirCleGemini(req);
            if (!apiKey) return res.status(500).json({ error: "Clé Gemini absente." });
            const contents = [{ parts: [{ text: prompt }] }];
            const resultat = await appelerGeminiStrict(contents, modelChoisi, apiKey);
            return res.json(resultat);
        }

        const apiKeyNano = obtenirCleNanoGPT(req);
        if (!apiKeyNano) return res.status(500).json({ error: "Clé NanoGPT absente." });

        const messages = [
            { role: "system", content: "Réponds STRICTEMENT en JSON en respectant les sauts de ligne entre chaque phrase." },
            { role: "user", content: prompt }
        ];

        const resultat = await appelerNanoGPTStrict(messages, modelChoisi, apiKeyNano);
        res.json(resultat);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. ENDPOINT EMMA (FLASH LITE)
app.post('/api/corriger-emma', async (req, res) => {
    try {
        const apiKey = obtenirCleGemini(req);
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
Question posée : "${question}"
Phrase écrite par l'élève : "${reponseEleve}"
Langue cible pour les explications de l'élève : ${nomLangue}.

[INSTRUCTIONS DE LANGUE]
${consigneLangue}
- La réponse amicale d'Emma doit TOUJOURS être en Français naturel et simple (A2-B1).
- Si la langue n'est pas le français, donne la traduction de cette réponse dans "traduction_reponse".
- Donne la traduction de la phrase corrigée dans "traduction_phrase_corrigee".

[ANTI-HALLUCINATION]
1. Regarde VRAIMENT la phrase de l'élève.
2. Si majuscule présente -> INTERDICTION de dire qu'elle manque.
3. Si point (.) présent -> INTERDICTION de dire qu'il manque.
4. Corrige uniquement les vraies fautes.

Structure JSON :
{
  "reponse_amicale": "...",
  "traduction_reponse": "...",
  "ce_qui_est_bien": "...",
  "les_fautes": "...",
  "phrase_corrigee": "...",
  "traduction_phrase_corrigee": "...",
  "ameliorations": "..."
}
`;
        const contents = [{ parts: [{ text: prompt }] }];
        const modeles = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];
        let resJson = null;
        for (const m of modeles) {
            try {
                resJson = await appelerGeminiStrict(contents, m, apiKey);
                if (resJson) break;
            } catch(e) {}
        }
        if (!resJson) throw new Error("Modèles Flash Lite momentanément indisponibles.");
        res.json(resJson);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. ENDPOINT GÉNÉRATION D'ENTRAÎNEMENT (FLASH LITE)
app.post('/api/generer-entrainement', async (req, res) => {
    try {
        const apiKey = obtenirCleGemini(req);
        if (!apiKey) return res.status(500).json({ error: "Clé Gemini absente." });

        const { titreSource, contexteExemples, format, nbPhrases } = req.body;
        const nombre = Math.min(Math.max(parseInt(nbPhrases) || 5, 3), 15);
        const typeFormat = format === 'text' ? 'text' : 'select';

        const prompt = `
Tu es un professeur de FLE créant des exercices d'entraînement.
Thème : "${titreSource}"
Exemples : ${JSON.stringify(contexteExemples || []).slice(0, 800)}
Génère ${nombre} phrases avec un trou "____".

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
        const modeles = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];
        let resJson = null;
        for (const m of modeles) {
            try {
                resJson = await appelerGeminiStrict(contents, m, apiKey);
                if (resJson) break;
            } catch(e) {}
        }
        res.json(resJson);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur French API actif sur le port ${PORT}`));
