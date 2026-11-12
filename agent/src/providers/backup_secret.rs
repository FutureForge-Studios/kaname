//! Backup secrets: the validation both providers share.
//!
//! `backup.secret_put` writes a restic repository password and the
//! destination's credentials to the agent's state directory; the restic
//! verbs name them by reference. Everything here is pure, so the linux
//! writer, the linux reader and the simulator apply the same rules. No
//! message produced here ever includes a password or a credential value;
//! they name the key at most.

use super::payloads::{BackupSecretEnv, BackupSecretPutParams};
use super::{PResult, ProviderError};

/// The directory under the agent's state dir that references resolve in.
pub const BACKUP_SECRETS_DIR: &str = "backup-secrets";

/// The suffix of the credentials file beside a password file.
pub const ENV_SUFFIX: &str = ".env";

/// The `.env` key that picks restic's S3 bucket addressing. It becomes
/// `-o s3.bucket-lookup=<value>` rather than an environment variable,
/// because restic reads that setting only as an option.
pub const BUCKET_LOOKUP_KEY: &str = "KANAME_S3_BUCKET_LOOKUP";

/// The only keys a `.env` file may carry, for the writer and the reader
/// alike. Anything else in a hand-edited file is dropped on read.
pub const SECRET_ENV_KEYS: [&str; 6] = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_DEFAULT_REGION",
    "B2_ACCOUNT_ID",
    "B2_ACCOUNT_KEY",
    BUCKET_LOOKUP_KEY,
];

pub const MAX_SECRET_REF: usize = 128;
pub const MAX_SECRET_VALUE: usize = 1024;
pub const BUCKET_LOOKUP_VALUES: [&str; 3] = ["auto", "dns", "path"];

fn invalid(message: impl Into<String>) -> ProviderError {
    ProviderError::invalid(message)
}

/// Keeps a reference a bare name, so it can only ever resolve inside the
/// agent's own secrets directory: 1..=128 of `[A-Za-z0-9._-]`, starting
/// with a letter or digit (no dotfiles, no `-flag`), never `..`, and never
/// ending in `.env`, which would collide with another reference's
/// credentials file. `field` is the parameter's wire name (`password_ref`
/// for the restic verbs, `ref` for the secret verbs), used in messages.
pub fn check_secret_ref(field: &str, reference: &str) -> PResult<()> {
    if reference.is_empty() || reference.len() > MAX_SECRET_REF {
        return Err(invalid(format!("{field} must be between 1 and 128 characters")));
    }
    if reference.contains(['/', '\\']) || reference.contains("..") || reference.contains('\0') {
        return Err(invalid(format!("{field} must be a bare name, not a path")));
    }
    if !reference
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_'))
    {
        return Err(invalid(format!("{field} contains an illegal character")));
    }
    if !reference.as_bytes()[0].is_ascii_alphanumeric() {
        return Err(invalid(format!("{field} must start with a letter or a digit")));
    }
    if reference.ends_with(ENV_SUFFIX) {
        return Err(invalid(format!("{field} may not end in .env")));
    }
    Ok(())
}

/// The refusal when `backup.secret_put` would change the password a
/// reference already holds. Names the reference, never either password.
pub fn password_change_refused(reference: &str) -> ProviderError {
    ProviderError::PreconditionFailed(format!(
        "backup secret {reference:?} already holds a different repository password; Kaname never \
         changes a repository password, because the repository it opens would be lost"
    ))
}

/// Whether a password file's content is `password`, allowing the one
/// trailing line break the writer adds (or a hand-installed `\r\n`).
pub fn password_matches(content: &[u8], password: &str) -> bool {
    let content = content.strip_suffix(b"\n").unwrap_or(content);
    let content = content.strip_suffix(b"\r").unwrap_or(content);
    content == password.as_bytes()
}

/// One line in a file restic reads: bounded, and no line break or NUL
/// that could end it early or add another.
fn check_line_value(what: &str, value: &str) -> PResult<()> {
    if value.is_empty() || value.len() > MAX_SECRET_VALUE {
        return Err(invalid(format!("{what} must be between 1 and 1024 bytes")));
    }
    if value.contains(['\n', '\r', '\0']) {
        return Err(invalid(format!("{what} may not contain a line break or NUL")));
    }
    Ok(())
}

pub fn check_secret_password(password: &str) -> PResult<()> {
    check_line_value("password", password)
}

/// Validates the credentials and returns them as `(KEY, value)` pairs in
/// the closed key order. Errors name the key, never the value.
pub fn check_secret_env(env: &BackupSecretEnv) -> PResult<Vec<(&'static str, String)>> {
    let mut out = Vec::new();
    for (key, value) in env.entries() {
        debug_assert!(SECRET_ENV_KEYS.contains(&key));
        check_line_value(key, value)?;
        if key == BUCKET_LOOKUP_KEY && !BUCKET_LOOKUP_VALUES.contains(&value) {
            return Err(invalid(format!("{key} must be one of auto, dns or path")));
        }
        out.push((key, value.to_string()));
    }
    Ok(out)
}

/// Everything `backup.secret_put` accepts, checked in one place.
pub fn check_secret_put(p: &BackupSecretPutParams) -> PResult<Vec<(&'static str, String)>> {
    check_secret_ref("ref", &p.reference)?;
    check_secret_password(&p.password)?;
    check_secret_env(&p.env)
}

/// The `.env` file's content: one `KEY=value` line per entry.
pub fn render_env(entries: &[(&'static str, String)]) -> String {
    let mut out = String::new();
    for (key, value) in entries {
        out.push_str(key);
        out.push('=');
        out.push_str(value);
        out.push('\n');
    }
    out
}

/// Reads a `.env` file back, keeping only the closed set of keys: a line
/// someone added by hand (`LD_PRELOAD=...`) never reaches restic.
pub fn parse_env(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.split('\n') {
        let line = line.trim_end_matches('\r');
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.trim_start().split_once('=') else {
            continue;
        };
        let key = key.trim();
        if SECRET_ENV_KEYS.contains(&key) && !value.is_empty() {
            out.push((key.to_string(), value.to_string()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWORD: &str = "correct-horse-battery-staple";
    const VALUE: &str = "AKIAEXAMPLESECRETVALUE";

    #[test]
    fn references_are_bare_names() {
        for good in [
            "nightly",
            "site-a.v2_key",
            "backup_schedule.0d6c3a52-8a9b-4c5e-9f00-1234567890ab",
            // A restore onto a host that is not the schedule's own.
            "backup_schedule.0d6c3a52-8a9b-4c5e-9f00-1234567890ab.j0123456789ab",
            "0abc",
            &"a".repeat(128),
        ] {
            assert!(check_secret_ref("ref", good).is_ok(), "{good:?} was refused");
        }
        for bad in [
            "",
            &"a".repeat(129),
            "../x",
            "a/b",
            "a\\b",
            ".hidden",
            "-flag",
            "_x",
            "x.env",
            "a..b",
            "a:b",
            "a b",
            "ref\0",
            "a\nb",
            "$(x)",
            "é",
        ] {
            assert!(check_secret_ref("ref", bad).is_err(), "{bad:?} was accepted");
        }
    }

    #[test]
    fn reference_errors_name_the_callers_field() {
        let err = check_secret_ref("ref", "../x").unwrap_err().to_string();
        assert!(err.contains("ref must") && !err.contains("password_ref"), "{err}");
        let err = check_secret_ref("password_ref", "").unwrap_err().to_string();
        assert!(err.contains("password_ref must"), "{err}");
    }

    #[test]
    fn password_files_compare_without_their_line_break() {
        assert!(password_matches(b"pw\n", "pw"));
        assert!(password_matches(b"pw\r\n", "pw"));
        assert!(password_matches(b"pw", "pw"));
        assert!(!password_matches(b"pw2\n", "pw"));
        assert!(!password_matches(b"pw\n\n", "pw"));
        let err = password_change_refused("nightly").to_string();
        assert!(err.contains("nightly") && err.contains("never"), "{err}");
    }

    #[test]
    fn passwords_are_one_bounded_line() {
        assert!(check_secret_password(PASSWORD).is_ok());
        assert!(check_secret_password(&"p".repeat(1024)).is_ok());
        for bad in ["", "a\nb", "a\rb", "a\0b", &"p".repeat(1025)] {
            let err = check_secret_password(bad).expect_err(bad);
            assert!(!err.to_string().contains(bad) || bad.is_empty());
        }
    }

    #[test]
    fn env_values_are_checked_and_never_echoed() {
        let env = BackupSecretEnv {
            aws_access_key_id: Some(format!("{VALUE}\nLD_PRELOAD=/tmp/x.so")),
            ..Default::default()
        };
        let err = check_secret_env(&env).unwrap_err().to_string();
        assert!(err.contains("AWS_ACCESS_KEY_ID"), "{err}");
        assert!(!err.contains(VALUE) && !err.contains("LD_PRELOAD"), "{err}");

        let env = BackupSecretEnv {
            kaname_s3_bucket_lookup: Some("bogus".into()),
            ..Default::default()
        };
        assert!(check_secret_env(&env).is_err());
        for empty_or_long in [String::new(), "v".repeat(1025)] {
            let env = BackupSecretEnv {
                b2_account_key: Some(empty_or_long),
                ..Default::default()
            };
            assert!(check_secret_env(&env).is_err());
        }

        let env = BackupSecretEnv {
            aws_access_key_id: Some("id".into()),
            aws_secret_access_key: Some("se=cret".into()),
            kaname_s3_bucket_lookup: Some("path".into()),
            ..Default::default()
        };
        let entries = check_secret_env(&env).unwrap();
        assert_eq!(
            render_env(&entries),
            "AWS_ACCESS_KEY_ID=id\nAWS_SECRET_ACCESS_KEY=se=cret\nKANAME_S3_BUCKET_LOOKUP=path\n"
        );
    }

    #[test]
    fn unknown_env_keys_are_a_decode_error() {
        let ok: BackupSecretPutParams = serde_json::from_value(serde_json::json!({
            "ref": "nightly",
            "password": PASSWORD,
            "env": {"B2_ACCOUNT_ID": "id", "B2_ACCOUNT_KEY": "key"},
        }))
        .unwrap();
        assert_eq!(ok.env.entries().len(), 2);
        for hostile in [
            serde_json::json!({"ref": "n", "password": PASSWORD, "env": {"LD_PRELOAD": "/tmp/x.so"}}),
            serde_json::json!({"ref": "n", "password": PASSWORD, "env": {"RESTIC_PASSWORD_COMMAND": "sh"}}),
            serde_json::json!({"ref": "n", "password": PASSWORD, "path": "/etc/shadow"}),
        ] {
            assert!(
                serde_json::from_value::<BackupSecretPutParams>(hostile.clone()).is_err(),
                "{hostile}"
            );
        }
    }

    #[test]
    fn debug_output_redacts_the_secret() {
        let p = BackupSecretPutParams {
            reference: "nightly".into(),
            password: PASSWORD.into(),
            env: BackupSecretEnv {
                aws_secret_access_key: Some(VALUE.into()),
                ..Default::default()
            },
        };
        let shown = format!("{p:?}");
        assert!(shown.contains("nightly") && shown.contains("AWS_SECRET_ACCESS_KEY"));
        assert!(!shown.contains(PASSWORD) && !shown.contains(VALUE), "{shown}");
    }

    #[test]
    fn the_reader_keeps_only_the_closed_set() {
        let parsed = parse_env(
            "# hand-edited\nAWS_ACCESS_KEY_ID=id\nLD_PRELOAD=/tmp/x.so\n RESTIC_PASSWORD_COMMAND=sh\nB2_ACCOUNT_KEY=a=b\r\nKANAME_S3_BUCKET_LOOKUP=path\nnot a line\n",
        );
        assert_eq!(
            parsed,
            vec![
                ("AWS_ACCESS_KEY_ID".to_string(), "id".to_string()),
                ("B2_ACCOUNT_KEY".to_string(), "a=b".to_string()),
                (BUCKET_LOOKUP_KEY.to_string(), "path".to_string()),
            ]
        );
    }
}
