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

// NETTOYEUR ET RÉPARATEUR DE JSON TOLÉRANT
function parserJSONSansErreur(texteBrut) {
    let t = texteBrut;
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    t = t.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

    const premierIndex = t.indexOf('{');
    const dernierIndex = t.lastIndexOf('}');
    if (premierIndex === -1 || dernierIndex === -1) {
        throw new Error("Aucun objet JSON valide n'a été détecté dans la réponse.");
    }
    t = t.substring(premierIndex, dernierIndex + 1);

    try {
        return JSON.parse(t);
    } catch (errOriginal) {
        try {
            let resultat = "";
            let dansChaine = false;
            let caractereEchappement = false;

            for (let i = 0; i < t.length; i++) {
                const char = t[i];
                if (char === '"' && !caractereEchappement) {
                    dansChaine = !dansChaine;
                    resultat += char;
                } else if (caractereEchappement) {
                    resultat += char;
                    caractereEchappement = false;
                } else if (char === '\\') {
                    resultat += char;
                    caractereEchappement = true;
                } else if (dansChaine && char === '\n') {
                    resultat += '\\n';
                } else if (dansChaine && char === '\r') {
                } else if (dansChaine && char === '\t') {
                    resultat += '\\t';
                } else {
                    resultat += char;
                }
            }
            return JSON.parse(resultat);
        } catch (errReparation) {
            throw new Error(`Erreur de syntaxe JSON : ${errOriginal.message}`);
        }
    }
}

// APPEL GEMINI
async function appelerGeminiStrict(contents, model, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: contents,
            generationConfig: { responseMimeType: "application/json", maxOutputTokens: 32000 }
        })
    });

    const data = await response.json();
    if (data.error) throw new Error(`[Gemini] ${data.error.message || JSON.stringify(data.error)}`);

    if (data.candidates && data.candidates[0].content && data.candidates[0].content.parts[0].text) {
        return parserJSONSansErreur(data.candidates[0].content.parts[0].text);
    }
    throw new Error("Réponse vide reçue de Gemini.");
}

// APPEL NANOGPT
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
            temperature: 0.2,
            max_tokens: 64000
        })
    });

    const data = await response.json();
    if (data.error) throw new Error(`[NanoGPT - ${model}] ${data.error.message || JSON.stringify(data.error)}`);

    if (data.choices && data.choices[0] && data.choices[0].message) {
        const contenu = data.choices[0].message.content || "";
        return parserJSONSansErreur(contenu);
    }
    throw new Error(`Aucune réponse exploitable renvoyée par ${model}.`);
}

// 1. ENDPOINT ANALYSE PDF
app.post('/api/analyser-pdf', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "Aucun fichier PDF reçu." });

        const modelChoisi = req.headers['x-model-choice'] || 'deepseek/deepseek-v4.1-flash:thinking';
        
        const promptStructure = `
Tu es un professeur expert de Français Langue Étrangère (FLE). Analyse ce document pédagogique et structure-le rigoureusement.

RÈGLE DU COURS AÉRÉ :
- Dans chaque slide de cours (dans "contenu_fr", "contenu_en" et "contenu_ko"), mets un double saut de ligne (\\n\\n) après chaque phrase ou exemple pour aérer la lecture.

RÈGLE D'EXHAUSTIVITÉ DES EXERCICES :
- Tu DOIS inclure ABSOLUMENT TOUTES LES QUESTIONS OU PHRASES du document, de la première à la toute dernière sans exception.
- DÉTECTION DU FORMAT D'EXERCICE :
  * Si l'exercice est à trous : conserve la phrase entière avec ses trous "____".
  * Si l'exercice est composé de questions ouvertes / réponses libres (ex: "Tu es arrivé(e) quand ?") : conserve l'intitulé exact de la question.

Structure JSON STRICTE à renvoyer :
{
  "titre": "Titre exact de la leçon",
  "bloc_cours": {
    "titre": "Cours théorique",
    "slides": [
      {
        "numero": 1,
        "titre": "Titre de la section",
        "contenu_fr": "Phrase 1...\\n\\nPhrase 2...\\n\\nExemple : ...",
        "contenu_en": "Sentence 1...\\n\\nSentence 2...\\n\\nExample: ...",
        "contenu_ko": "설명 1...\\n\\n설명 2...\\n\\n예문: ..."
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
          "fr": "Question en français ?",
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
          "fr": "Explication..
