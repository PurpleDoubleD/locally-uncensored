//! A33 (Discord, 17.11.2026): since 3.1.0 a right click in a text field opens
//! LU's own menu (W33, src/components/ui/TextContextMenu.tsx) instead of the
//! web view's, and with the web view's menu went the spelling suggestions it
//! carried. The web view underlines a misspelled word with the spell checker
//! of the system; this asks that same checker for the word, so LU's own menu
//! can offer the suggestions again.
//!
//! macOS: NSSpellChecker, the checker WKWebView underlines with.
//! Windows: the Spell Checking API (ISpellChecker), the checker WebView2
//! underlines with. Everywhere else (Linux, the phones) the answer is "not
//! misspelled": WebKitGTK as Tauri sets it up checks no spelling, so there is
//! no underline there to answer for.

use serde::Serialize;

/// The most suggestions the menu shows, as the web view's own menus do.
pub const MAX_SUGGESTIONS: usize = 5;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SpellAnswer {
    pub misspelled: bool,
    pub suggestions: Vec<String>,
}

/// One word, as the menu sends it: trimmed, a single word of letters (with
/// inner apostrophes or hyphens), not longer than a word gets. Anything else
/// is not checked at all, so the system checker never sees a whole prompt.
pub fn checkable_word(raw: &str) -> Option<&str> {
    let w = raw.trim();
    if w.is_empty() || w.chars().count() > 64 {
        return None;
    }
    if !w.chars().next().is_some_and(char::is_alphabetic) || !w.chars().last().is_some_and(char::is_alphabetic) {
        return None;
    }
    if !w.chars().all(|c| c.is_alphabetic() || c == '\'' || c == '’' || c == '-') {
        return None;
    }
    Some(w)
}

/// Suggestions in the checker's order, without the word itself, empties and
/// repeats, at most `MAX_SUGGESTIONS`.
pub fn tidy_suggestions(word: &str, raw: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in raw {
        let s = s.trim().to_string();
        if s.is_empty() || s == word || out.contains(&s) {
            continue;
        }
        out.push(s);
        if out.len() == MAX_SUGGESTIONS {
            break;
        }
    }
    out
}

/// The languages a word is checked in: the user's own first (at most two),
/// English always. Prompts are written in English more often than not,
/// whatever the system speaks, and the checkers' "automatic" language guess
/// is no guess at all for a single word (it offered "Recife" for "recieve").
pub fn languages_to_check(user: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for l in user.iter().map(|l| l.trim()).filter(|l| !l.is_empty()).take(2) {
        if !out.iter().any(|o| o.eq_ignore_ascii_case(l)) {
            out.push(l.to_string());
        }
    }
    if !out.iter().any(|o| o.to_ascii_lowercase().starts_with("en")) {
        out.push("en".to_string());
    }
    out
}

/// What the checkers of all languages say together: a word one language
/// knows is not misspelled; otherwise the suggestions of every language, the
/// first of each before the second of any.
pub fn combine(word: &str, per_language: Vec<Option<Vec<String>>>) -> SpellAnswer {
    // None = that language knows the word.
    if per_language.is_empty() || per_language.iter().any(Option::is_none) {
        return SpellAnswer::default();
    }
    let lists: Vec<Vec<String>> = per_language.into_iter().flatten().collect();
    let longest = lists.iter().map(Vec::len).max().unwrap_or(0);
    let mut merged = Vec::new();
    for i in 0..longest {
        for l in &lists {
            if let Some(s) = l.get(i) {
                merged.push(s.clone());
            }
        }
    }
    SpellAnswer { misspelled: true, suggestions: tidy_suggestions(word, merged) }
}

/// A33 on Windows (box run 20.11.2026): a German Windows without the English
/// spelling data has no "en-US" checker, and German alone then marked right
/// English words as typos ("house" -> Housse, Hose; "the" -> Theo). Prompts
/// are English more often than not, so without an English checker the answer
/// is "not misspelled", as before A33: no suggestion beats a wrong one.
pub fn english_or_nothing(english_checked: bool, answer: SpellAnswer) -> SpellAnswer {
    if english_checked {
        answer
    } else {
        SpellAnswer::default()
    }
}

#[cfg(target_os = "macos")]
fn check_system(word: &str) -> Result<SpellAnswer, String> {
    use objc2_app_kit::NSSpellChecker;
    use objc2_foundation::{NSRange, NSString};

    let text = NSString::from_str(word);
    let checker = NSSpellChecker::sharedSpellChecker();
    let available: Vec<String> = checker.availableLanguages().iter().map(|s| s.to_string()).collect();
    let user: Vec<String> = checker.userPreferredLanguages().iter().map(|s| s.to_string()).collect();
    let mut per_language = Vec::new();
    let mut english_checked = false;
    for lang in languages_to_check(&user) {
        // "en" is not a checker of its own on every Mac; "en_US" or "en_GB" is.
        let Some(lang) = available
            .iter()
            .find(|a| a.eq_ignore_ascii_case(&lang))
            .or_else(|| available.iter().find(|a| a.to_ascii_lowercase().starts_with(&format!("{}_", lang.to_ascii_lowercase()))))
            .cloned()
        else {
            continue;
        };
        english_checked |= lang.to_ascii_lowercase().starts_with("en");
        let lang_ns = NSString::from_str(&lang);
        // SAFETY: a null word count is allowed by the method.
        let miss = unsafe {
            checker.checkSpellingOfString_startingAt_language_wrap_inSpellDocumentWithTag_wordCount(
                &text, 0, Some(&lang_ns), false, 0, std::ptr::null_mut(),
            )
        };
        // NSNotFound in `location` (or an empty range): nothing misspelled.
        if miss.length == 0 || miss.location >= text.length() {
            per_language.push(None);
            continue;
        }
        let range = NSRange::new(0, text.length());
        let guesses = checker.guessesForWordRange_inString_language_inSpellDocumentWithTag(range, &text, Some(&lang_ns), 0);
        per_language.push(Some(guesses.map(|a| a.iter().map(|s| s.to_string()).collect()).unwrap_or_default()));
    }
    Ok(english_or_nothing(english_checked, combine(word, per_language)))
}

#[cfg(target_os = "windows")]
fn check_system(word: &str) -> Result<SpellAnswer, String> {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Globalization::{
        GetUserDefaultLocaleName, ISpellChecker, ISpellCheckerFactory, ISpellingError, SpellCheckerFactory,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};

    // SAFETY: plain COM calls on this blocking-pool thread. CoInitializeEx is
    // allowed to answer "already initialised"; nothing here is shared.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let factory: ISpellCheckerFactory =
            CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
        let mut buf = [0u16; 85];
        let n = GetUserDefaultLocaleName(&mut buf);
        let user = if n > 1 { vec![String::from_utf16_lossy(&buf[..(n as usize - 1)])] } else { Vec::new() };

        let text = HSTRING::from(word);
        let mut per_language = Vec::new();
        let mut english_checked = false;
        for lang in languages_to_check(&user) {
            let lang = if lang == "en" { "en-US".to_string() } else { lang };
            let tag = HSTRING::from(lang.as_str());
            if !factory.IsSupported(&tag).map(|b| b.as_bool()).unwrap_or(false) {
                continue;
            }
            let Ok(checker): Result<ISpellChecker, _> = factory.CreateSpellChecker(&tag) else { continue };
            english_checked |= lang.to_ascii_lowercase().starts_with("en");
            let errors = checker.Check(&text).map_err(|e| e.to_string())?;
            let mut err: Option<ISpellingError> = None;
            let hr = errors.Next(&mut err);
            if hr.is_err() || hr.0 == 1 || err.is_none() {
                // S_FALSE: no error, this language knows the word.
                per_language.push(None);
                continue;
            }
            let mut raw = Vec::new();
            if let Ok(list) = checker.Suggest(&text) {
                loop {
                    let mut item = [PWSTR::null()];
                    let mut fetched = 0u32;
                    if list.Next(&mut item, Some(&mut fetched)).is_err() || fetched == 0 {
                        break;
                    }
                    if let Ok(s) = item[0].to_string() {
                        raw.push(s);
                    }
                    CoTaskMemFree(Some(item[0].0 as *const _));
                }
            }
            per_language.push(Some(raw));
        }
        Ok(english_or_nothing(english_checked, combine(word, per_language)))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn check_system(_word: &str) -> Result<SpellAnswer, String> {
    Ok(SpellAnswer::default())
}

/// The word under a right click in a text field: is it misspelled, and what
/// would the system checker put instead. Never fails the menu: any trouble
/// with the checker answers "not misspelled".
#[tauri::command]
pub async fn spell_suggestions(word: String) -> Result<SpellAnswer, String> {
    let Some(word) = checkable_word(&word).map(str::to_string) else {
        return Ok(SpellAnswer::default());
    };
    let answer = tauri::async_runtime::spawn_blocking(move || check_system(&word))
        .await
        .map_err(|e| e.to_string())?;
    Ok(answer.unwrap_or_else(|e| {
        tracing::warn!("spell check failed: {e}");
        SpellAnswer::default()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_single_word_reaches_the_checker() {
        assert_eq!(checkable_word("  recieve "), Some("recieve"));
        assert_eq!(checkable_word("don't"), Some("don't"));
        assert_eq!(checkable_word("state-of-the-art"), Some("state-of-the-art"));
        assert_eq!(checkable_word("Übermaß"), Some("Übermaß"));
        for no in ["", "two words", "word.", "1girl", "a,b", "<lora:x>", &"a".repeat(65)] {
            assert_eq!(checkable_word(no), None, "{no}");
        }
    }

    #[test]
    fn suggestions_are_tidied_and_capped() {
        let raw = ["receive", "receive", "", "recieve", "relieve", "reverie", "deceive", "recede", "reweave"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(tidy_suggestions("recieve", raw), vec!["receive", "relieve", "reverie", "deceive", "recede"]);
    }

    #[test]
    fn the_user_language_and_english_are_checked() {
        assert_eq!(languages_to_check(&["de".into(), "en".into(), "fr".into()]), vec!["de", "en"]);
        assert_eq!(languages_to_check(&["de-DE".into()]), vec!["de-DE", "en"]);
        assert_eq!(languages_to_check(&["en-GB".into()]), vec!["en-GB"]);
        assert_eq!(languages_to_check(&[]), vec!["en"]);
    }

    #[test]
    fn a_word_one_language_knows_is_no_typo() {
        let de_knows = combine("Hund", vec![None, Some(vec!["Hunt".into()])]);
        assert_eq!(de_knows, SpellAnswer::default());
        assert_eq!(combine("x", vec![]), SpellAnswer::default(), "no checker, no claim");
        let both = combine("recieve", vec![Some(vec!["Recife".into(), "rezive".into()]), Some(vec!["receive".into(), "relieve".into()])]);
        assert!(both.misspelled);
        assert_eq!(both.suggestions, vec!["Recife", "receive", "rezive", "relieve"]);
    }

    /// The real checker of this machine. macOS ships English, so a plain
    /// typo is found and its fix offered; a right word is left alone.
    #[test]
    fn without_an_english_checker_nothing_counts_as_misspelled() {
        // The box: German only, "house" got German suggestions.
        let german_only = combine("house", vec![Some(vec!["Housse".into(), "Hose".into()])]);
        assert!(german_only.misspelled);
        assert_eq!(english_or_nothing(false, german_only), SpellAnswer::default());
        // With English there, the combined answer stays as it is.
        let both = combine("recieve", vec![Some(vec!["Receiver".into()]), Some(vec!["receive".into()])]);
        assert!(both.misspelled);
        assert_eq!(english_or_nothing(true, both.clone()), both);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_mac_checker_answers_for_a_typo_and_a_right_word() {
        let typo = check_system("recieve").expect("checker");
        assert!(typo.misspelled);
        assert!(typo.suggestions.iter().any(|s| s == "receive"), "{:?}", typo.suggestions);
        assert_eq!(check_system("receive").expect("checker"), SpellAnswer::default());
    }
}
