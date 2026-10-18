//! Which files to install, from the GitHub releases of FORGE. Mirrors pickInstaller in
//! packages/sidecar/src/update/app-update.ts: the newest full installer for the runtime of the newest
//! small update, then that update when it is newer. Only signed assets count (ADR 0013).

use std::cmp::Ordering;

use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;

use crate::t;

pub const REPO: &str = "vanturis/forge";

/// Public half of the release signing key, the same as in packages/sidecar/src/update/signature.ts.
const PUBLIC_KEY_SPKI: &str = "MCowBQYDK2VwAyEANolNUx40wUqNPeUVaSGEP8kerxC73987vPWhk9Y6Buc=";

#[derive(Deserialize, Clone, Debug)]
pub struct Asset {
    pub name: String,
    #[serde(default)]
    pub size: u64,
    pub browser_download_url: String,
    #[serde(default)]
    pub digest: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Release {
    pub tag_name: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub assets: Vec<Asset>,
}

/// An asset with the file that holds its signature (FORGE_<v>.sig, or <asset>.sig up to 0.1.101).
#[derive(Clone, Debug)]
pub struct Signed {
    pub asset: Asset,
    pub sig: Asset,
}

#[derive(Clone, Debug)]
pub struct Plan {
    /// version FORGE has after the install
    pub version: String,
    pub installer: Signed,
    /// small update of a newer release for the installer's runtime, applied right after it
    pub patch: Option<Signed>,
}

impl Plan {
    pub fn download_bytes(&self) -> u64 {
        self.installer.asset.size + self.patch.as_ref().map_or(0, |p| p.asset.size)
    }
}

pub fn fetch() -> Result<Vec<Release>, String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases?per_page=100");
    let res = crate::install::agent()
        .get(&url)
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(403 | 429, _) => t("GitHub lässt gerade keine Abfrage zu. Versuche es in ein paar Minuten erneut.", "GitHub is refusing requests right now. Try again in a few minutes."),
            ureq::Error::Status(code, _) => format!("{} (HTTP {code})", t("GitHub antwortet nicht wie erwartet", "GitHub answered unexpectedly")),
            ureq::Error::Transport(_) => t("Keine Verbindung zu GitHub. Prüfe die Internetverbindung.", "No connection to GitHub. Check the internet connection."),
        })?;
    res.into_json::<Vec<Release>>().map_err(|e| e.to_string())
}

pub fn version_of(tag: &str) -> Option<Vec<u32>> {
    let v = tag.strip_prefix('v').unwrap_or(tag);
    v.split('.').map(|n| n.parse().ok()).collect()
}

fn compare(a: &str, b: &str) -> Ordering {
    version_of(a).cmp(&version_of(b))
}

fn bare(tag: &str) -> String {
    tag.trim_start_matches('v').to_string()
}

/// Only real versions (tags like v0.1.104), newest first. The setup itself lives in a prerelease.
fn published(releases: &[Release]) -> Vec<Release> {
    let mut list: Vec<Release> = releases.iter().filter(|r| !r.draft && !r.prerelease && version_of(&r.tag_name).is_some()).cloned().collect();
    list.sort_by(|a, b| compare(&b.tag_name, &a.tag_name));
    list
}

/// FORGE_<v>.sig, the signature file of a whole release: no underscore after the version.
fn is_manifest(name: &str) -> bool {
    name.strip_prefix("FORGE_").and_then(|r| r.strip_suffix(".sig")).is_some_and(|v| !v.contains('_'))
}

fn signed(rel: &Release) -> Vec<Signed> {
    let manifest = rel.assets.iter().find(|a| is_manifest(&a.name));
    rel.assets
        .iter()
        .filter(|a| !a.name.ends_with(".sig"))
        .filter_map(|a| {
            let own = rel.assets.iter().find(|s| s.name == format!("{}.sig", a.name));
            own.or(manifest).map(|sig| Signed { asset: a.clone(), sig: sig.clone() })
        })
        .collect()
}

fn is_installer(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with("_x64-setup.exe")
}

/// Runtime key of a small update: FORGE_<v>_update_<key>.zip
pub fn patch_key(name: &str) -> Option<&str> {
    let (_, rest) = name.split_once("_update_")?;
    rest.strip_suffix(".zip")
}

/// Runtime key in a long installer name (0.1.8 up to 0.1.8x): FORGE_<v>_<key>_x64-setup.exe
fn keyed_installer(name: &str) -> Option<&str> {
    let (_, rest) = name.strip_prefix("FORGE_")?.split_once('_')?;
    rest.strip_suffix("_x64-setup.exe").filter(|k| !k.is_empty())
}

/// Marker next to the installer up to 0.1.101: FORGE_<v>_x64-setup.<key>.runtime
fn marker_key(name: &str) -> Option<&str> {
    let (_, rest) = name.strip_prefix("FORGE_")?.split_once('_')?;
    rest.strip_prefix("x64-setup.")?.strip_suffix(".runtime")
}

fn installer_key(rel: &Release, installer: &str) -> Option<String> {
    if let Some(k) = keyed_installer(installer) {
        return Some(k.to_string());
    }
    if let Some(k) = rel.assets.iter().find_map(|a| marker_key(&a.name)) {
        return Some(k.to_string());
    }
    rel.assets.iter().find_map(|a| patch_key(&a.name)).map(str::to_string)
}

pub fn pick(releases: &[Release]) -> Result<Plan, String> {
    let list: Vec<(Release, Vec<Signed>)> = published(releases).into_iter().map(|r| {
        let s = signed(&r);
        (r, s)
    }).collect();
    let newest_patch = |key: Option<&str>| {
        list.iter().find_map(|(rel, assets)| {
            assets.iter().find(|s| patch_key(&s.asset.name).is_some_and(|k| key.is_none_or(|want| want == k))).map(|s| (rel, s))
        })
    };
    let target = newest_patch(None).and_then(|(_, s)| patch_key(&s.asset.name).map(str::to_string));
    let installer_for = |key: Option<&str>| {
        list.iter().find_map(|(rel, assets)| {
            assets
                .iter()
                .find(|s| is_installer(&s.asset.name) && key.is_none_or(|k| installer_key(rel, &s.asset.name).as_deref() == Some(k)))
                .map(|s| (rel, s))
        })
    };
    let (rel, installer) = installer_for(target.as_deref())
        .or_else(|| installer_for(None))
        .ok_or_else(|| t("Auf GitHub gibt es noch keinen passenden Installer.", "There is no matching installer on GitHub yet."))?;
    let key = installer_key(rel, &installer.asset.name);
    let patch = key
        .as_deref()
        .and_then(|k| newest_patch(Some(k)))
        .filter(|(p, _)| compare(&p.tag_name, &rel.tag_name) == Ordering::Greater);
    Ok(Plan {
        version: bare(&patch.map_or(&rel.tag_name, |(p, _)| &p.tag_name)),
        installer: installer.clone(),
        patch: patch.map(|(_, s)| s.clone()),
    })
}

/// The signature for `name` from the content of its signature file.
pub fn signature_from(sig_name: &str, content: &str, name: &str) -> Option<String> {
    if !is_manifest(sig_name) {
        return Some(content.trim().to_string());
    }
    let json: serde_json::Value = serde_json::from_str(content).ok()?;
    json.get(name)?.as_str().map(str::to_string)
}

/// Ed25519 over "FORGE-UPDATE-1\n<name>\n<sha256 hex>", as scripts/sign-update.mjs signs.
pub fn verify(name: &str, sha256_hex: &str, signature_b64: &str) -> bool {
    let b64 = base64::engine::general_purpose::STANDARD;
    let Ok(spki) = b64.decode(PUBLIC_KEY_SPKI) else { return false };
    let Ok(raw): Result<[u8; 32], _> = spki[spki.len() - 32..].try_into() else { return false };
    let Ok(key) = VerifyingKey::from_bytes(&raw) else { return false };
    let Ok(sig) = b64.decode(signature_b64.trim()) else { return false };
    let Ok(sig) = Signature::from_slice(&sig) else { return false };
    let message = format!("FORGE-UPDATE-1\n{name}\n{}", sha256_hex.to_ascii_lowercase());
    key.verify(message.as_bytes(), &sig).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "node-24.21.0_git-2.56.0.2_gh-2.102.0_python-3.14.8";

    fn asset(name: &str) -> Asset {
        Asset { name: name.into(), size: 10, browser_download_url: format!("https://x/{name}"), digest: None }
    }

    fn release(tag: &str, names: &[&str]) -> Release {
        Release { tag_name: tag.into(), draft: false, prerelease: false, assets: names.iter().map(|n| asset(n)).collect() }
    }

    #[test]
    fn installer_of_the_newest_runtime_then_the_newer_update() {
        let zip = |v: &str| format!("FORGE_{v}_update_{KEY}.zip");
        let rels = vec![
            release("v0.1.106", &[&zip("0.1.106"), "FORGE_0.1.106.sig"]),
            release("v0.1.104", &[&zip("0.1.104"), "FORGE_0.1.104_x64-setup.exe", "FORGE_0.1.104.sig"]),
            release("v0.1.103", &[&zip("0.1.103"), "FORGE_0.1.103_x64-setup.exe", "FORGE_0.1.103.sig"]),
            Release { prerelease: true, ..release("installer", &["FORGE-Setup.exe"]) },
        ];
        let plan = pick(&rels).unwrap();
        assert_eq!(plan.installer.asset.name, "FORGE_0.1.104_x64-setup.exe");
        assert_eq!(plan.installer.sig.name, "FORGE_0.1.104.sig");
        assert_eq!(plan.patch.unwrap().asset.name, zip("0.1.106"));
        assert_eq!(plan.version, "0.1.106");
    }

    #[test]
    fn unsigned_assets_do_not_count() {
        let rels = vec![
            release("v0.1.105", &["FORGE_0.1.105_x64-setup.exe", &format!("FORGE_0.1.105_update_{KEY}.zip")]),
            release("v0.1.101", &["FORGE_0.1.101_x64-setup.exe", "FORGE_0.1.101_x64-setup.exe.sig", &format!("FORGE_0.1.101_x64-setup.{KEY}.runtime")]),
        ];
        let plan = pick(&rels).unwrap();
        assert_eq!(plan.installer.sig.name, "FORGE_0.1.101_x64-setup.exe.sig");
        assert!(plan.patch.is_none());
        assert_eq!(plan.version, "0.1.101");
    }

    /// Against the real releases: cargo test -- --ignored live
    #[test]
    #[ignore]
    fn live() {
        let plan = pick(&fetch().unwrap()).unwrap();
        let mb = plan.download_bytes() / 1_048_576;
        println!("{} {} {:?} {mb} MB", plan.version, plan.installer.asset.name, plan.patch.map(|p| p.asset.name));
    }

    #[test]
    fn names() {
        assert!(is_manifest("FORGE_0.1.104.sig"));
        assert!(!is_manifest("FORGE_0.1.104_x64-setup.exe.sig"));
        assert_eq!(keyed_installer(&format!("FORGE_0.1.85_{KEY}_x64-setup.exe")), Some(KEY));
        assert_eq!(keyed_installer("FORGE_0.1.104_x64-setup.exe"), None);
        assert_eq!(marker_key(&format!("FORGE_0.1.101_x64-setup.{KEY}.runtime")), Some(KEY));
        assert_eq!(version_of("installer"), None);
    }

    #[test]
    fn signature_of_a_real_release() {
        // Update zip of release v0.1.103: name, SHA-256 as GitHub reports it, signature from FORGE_0.1.103.sig.
        let name = format!("FORGE_0.1.103_update_{KEY}.zip");
        let hash = "c18a0e5d23808a9a9db9ddd80031bd7914c6ba83e27838a8e658816dc1b5b32b";
        let sig = "4mTNCOhkXs4J3QCWjWj5+bI72Mg8AF80XPe+1pxKK3ZF158JivUDyW0poOIgmSNmvzlK+ZNNUD7e+5CyKdE9DQ==";
        assert!(verify(&name, hash, sig));
        assert!(!verify("FORGE_0.1.103_x64-setup.exe", hash, sig));
        assert!(!verify(&name, &hash.replace('c', "d"), sig));
        assert_eq!(signature_from("FORGE_1.sig", r#"{"a.zip":"c2ln"}"#, "a.zip").as_deref(), Some("c2ln"));
        assert_eq!(signature_from("a.zip.sig", " c2ln\n", "a.zip").as_deref(), Some("c2ln"));
    }
}
