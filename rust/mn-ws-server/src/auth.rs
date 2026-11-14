//! server 侧的认证：统一登录的公开参数 + 设备令牌的签发与校验。
//!
//! 与 mn-rt 的 server/src/auth.js 同构，但**没有 sessionKey**：
//! mn-ws 桥接的是 HTTP 请求，不是加密信封流，桥接层不需要「会话密钥」概念。
//!
//! 两类凭据：
//!   · 认证中心 access_token —— 短命，登录当场换设备令牌用完即弃，不落盘。
//!   · mn-ws 设备令牌（HS256 JWT）—— 长命，落盘，由本服务签发与吊销。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// 设备令牌有效期（秒）。默认 90 天 —— 桥接是公网暴露面，令牌不宜过长。
pub const DEVICE_TOKEN_TTL_SEC: i64 = 90 * 24 * 3600;

/// base64url（无 padding）。
pub fn b64url(data: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(data)
}

/// base64url 编码一段 JSON。
pub fn b64url_json(obj: &Value) -> String {
    b64url(&serde_json::to_vec(obj).unwrap_or_default())
}

/// base64url 解码（自动补 padding）。
pub fn from_b64url(s: &str) -> Option<Vec<u8>> {
    let pad = "=".repeat((4 - (s.len() % 4)) % 4);
    let swapped = s.replace('-', "+").replace('_', "/");
    base64::engine::general_purpose::STANDARD
        .decode(swapped + &pad)
        .ok()
}

/// 设备令牌的 payload。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceTokenPayload {
    pub sub: String,
    pub cid: String,
    pub dn: String,
    pub iat: i64,
    pub exp: i64,
    pub jti: String,
}

/// 一台已登记的桥（client half）：clientId → 属主。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceRecord {
    pub user_id: String,
    pub client_id: String,
    pub device_name: String,
    pub registered_at: String,
    pub last_seen_at: String,
}

/// 认证中心的发现文档（只用到其中几个端点，其余字段原样带过）。
#[derive(Debug, Clone, Default)]
pub struct IdpEndpoints {
    pub authorization_endpoint: Option<String>,
    pub token_endpoint: Option<String>,
    pub userinfo_endpoint: Option<String>,
    pub end_session_endpoint: Option<String>,
    pub issuer: Option<String>,
}

/// 公开参数（绝不含 secret）。
#[derive(Debug, Clone)]
pub struct PublicAuthConfig {
    pub enabled: bool,
    pub issuer: String,
    pub client_id: String,
    pub login_client_id: String,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub idp_available: bool,
    pub idp_error: Option<String>,
}

/// 身份（认证中心自己断言的 sub）。
#[derive(Debug, Clone, Default)]
pub struct Identity {
    pub user_id: String,
    pub sub: String,
    pub email: String,
    pub name: String,
    pub preferred_username: String,
}

/// 认证中心的一次失败（带错误码）。
#[derive(Debug, Clone)]
pub struct AuthError {
    pub code: String,
    pub message: String,
}

impl AuthError {
    pub fn new(code: &str, message: impl Into<String>) -> AuthError {
        AuthError {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

/// AuthHub：统一登录的公开参数 + 设备令牌的签发与校验。
pub struct AuthHub {
    pub enabled: bool,
    pub issuer: String,
    pub client_id: String,
    pub login_client_id: String,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
    pub jwt_secret: String,
    pub http_timeout_ms: u64,
    pub data_dir: Option<PathBuf>,
    /// 发现文档缓存。只有成功才固化——失败若被记住，容器编排下
    /// 「本服务先于认证中心启动」会让统一登录永久不可用直到重启。
    endpoints: Mutex<Option<IdpEndpoints>>,
    discover_error: Mutex<String>,
    /// clientId → {userId, deviceName, registeredAt, lastSeenAt}
    devices: Mutex<Vec<DeviceRecord>>,
    /// jti → 过期时间戳（吊销名单）
    revoked: Mutex<Vec<(String, i64)>>,
}

/// 签发结果。
#[derive(Debug, Clone)]
pub struct IssuedToken {
    pub token: String,
    pub expires_at: i64,
    pub jti: String,
}

impl AuthHub {
    /// 构造。
    pub fn new(
        enabled: bool,
        issuer: &str,
        client_id: &str,
        login_client_id: &str,
        redirect_uri: &str,
        jwt_secret: &str,
        data_dir: Option<&Path>,
    ) -> AuthHub {
        let hub = AuthHub {
            enabled,
            issuer: issuer.to_string(),
            client_id: client_id.to_string(),
            login_client_id: login_client_id.to_string(),
            redirect_uri: redirect_uri.to_string(),
            scopes: vec![
                "openid".to_string(),
                "profile".to_string(),
                "email".to_string(),
            ],
            jwt_secret: jwt_secret.to_string(),
            http_timeout_ms: 10_000,
            data_dir: data_dir.map(|d| d.to_path_buf()),
            endpoints: Mutex::new(None),
            discover_error: Mutex::new(String::new()),
            devices: Mutex::new(Vec::new()),
            revoked: Mutex::new(Vec::new()),
        };
        hub.load_devices();
        hub
    }

    /// 下发给客户端的公开参数。**绝不含任何 secret**。
    pub fn public_config(&self) -> PublicAuthConfig {
        let endpoints = self.endpoints.lock().unwrap().clone();
        let mut cfg = PublicAuthConfig {
            enabled: self.enabled,
            issuer: self.issuer.clone(),
            client_id: self.client_id.clone(),
            login_client_id: if self.login_client_id.is_empty() {
                self.client_id.clone()
            } else {
                self.login_client_id.clone()
            },
            redirect_uri: self.redirect_uri.clone(),
            scopes: self.scopes.clone(),
            authorization_endpoint: endpoints
                .as_ref()
                .and_then(|e| e.authorization_endpoint.clone())
                .unwrap_or_else(|| format!("{}/oauth2/auth", self.issuer)),
            token_endpoint: endpoints
                .as_ref()
                .and_then(|e| e.token_endpoint.clone())
                .unwrap_or_else(|| format!("{}/oauth2/token", self.issuer)),
            idp_available: endpoints.is_some(),
            idp_error: None,
        };
        if !cfg.idp_available {
            let err = self.discover_error.lock().unwrap().clone();
            cfg.idp_error = Some(if err.is_empty() {
                "未拉取到发现文档".to_string()
            } else {
                err
            });
        }
        cfg
    }

    /// 拉取（并缓存）发现文档。
    pub async fn discover(&self) -> Result<IdpEndpoints, AuthError> {
        if let Some(e) = self.endpoints.lock().unwrap().clone() {
            return Ok(e);
        }
        if !self.enabled {
            return Err(AuthError::new("disabled", "统一登录未启用"));
        }
        let url = format!(
            "{}/.well-known/openid-configuration",
            self.issuer.trim_end_matches('/')
        );
        let doc = self
            .fetch_json(&url, "GET", None, None)
            .await
            .map_err(|e| AuthError::new("discover_failed", e.message))?;
        let token_endpoint = doc
            .get("token_endpoint")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let Some(token_endpoint) = token_endpoint else {
            *self.discover_error.lock().unwrap() = "发现文档不完整".to_string();
            return Err(AuthError::new("bad_discovery", "发现文档不完整"));
        };
        let endpoints = IdpEndpoints {
            authorization_endpoint: doc
                .get("authorization_endpoint")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            token_endpoint: Some(token_endpoint),
            userinfo_endpoint: doc
                .get("userinfo_endpoint")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            end_session_endpoint: doc
                .get("end_session_endpoint")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            issuer: doc.get("issuer").and_then(|v| v.as_str()).map(|s| s.to_string()),
        };
        *self.endpoints.lock().unwrap() = Some(endpoints.clone());
        *self.discover_error.lock().unwrap() = String::new();
        Ok(endpoints)
    }

    /// 用**授权码 + PKCE verifier** 换身份。
    ///
    /// ⚠️ 换码用的 client_id 必须是 **client 半的身份**（loginClientId），
    /// 不是 server 半那个：授权码是在铸码那一步按 client_id 绑定的，
    /// 换的时候必须用同一个 id，否则认证中心直接判 invalid_grant。
    ///
    /// 之所以要「服务端换码」而不是「客户端换码再把 access_token 送回来」：
    /// 后者会让一枚指向整个平台身份的高价值凭据流经手机 —— 截获即账号接管。
    pub async fn exchange(
        &self,
        code: &str,
        code_verifier: &str,
        redirect_uri: Option<&str>,
    ) -> Result<Identity, AuthError> {
        if !self.enabled {
            return Err(AuthError::new("disabled", "统一登录未启用"));
        }
        if code.is_empty() || code_verifier.is_empty() {
            return Err(AuthError::new("bad_request", "缺少 code / codeVerifier"));
        }
        let doc = self.discover().await?;
        let client_id = if self.login_client_id.is_empty() {
            &self.client_id
        } else {
            &self.login_client_id
        };
        let redirect = redirect_uri
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.redirect_uri)
            .to_string();

        // 表单编码（application/x-www-form-urlencoded）。
        let form = format!(
            "grant_type=authorization_code&code={}&client_id={}&redirect_uri={}&code_verifier={}",
            urlencode(code),
            urlencode(client_id),
            urlencode(&redirect),
            urlencode(code_verifier)
        );
        let token_url = doc
            .token_endpoint
            .clone()
            .unwrap_or_else(|| format!("{}/oauth2/token", self.issuer));
        let tok = self
            .fetch_json(
                &token_url,
                "POST",
                Some("application/x-www-form-urlencoded"),
                Some(form.into_bytes()),
            )
            .await
            .map_err(|e| AuthError::new("token_request_failed", e.message))?;

        if let Some(err) = tok.get("error").and_then(|v| v.as_str()) {
            let desc = tok
                .get("error_description")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            return Err(AuthError::new(
                err,
                format!("换 token 被拒: {err} {desc}").trim().to_string(),
            ));
        }
        let access_token = tok
            .get("access_token")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if access_token.is_empty() {
            return Err(AuthError::new("no_access_token", "令牌响应缺少 access_token"));
        }

        // 让认证中心自己断言身份。用完即弃：这枚 access_token 不进任何存储。
        let userinfo_url = doc
            .userinfo_endpoint
            .clone()
            .unwrap_or_else(|| format!("{}/oauth2/userinfo", self.issuer));
        let ui = self
            .fetch_json_with_auth(&userinfo_url, access_token)
            .await
            .map_err(|e| AuthError::new("userinfo_failed", e.message))?;
        identity_of(&ui)
    }

    /// 校验一枚**认证中心**的 access_token，返回身份。
    pub async fn verify_bearer(&self, access_token: &str) -> Result<Identity, AuthError> {
        if access_token.is_empty() {
            return Err(AuthError::new("bad_request", "缺少 access_token"));
        }
        let doc = self.discover().await?;
        let userinfo_url = doc
            .userinfo_endpoint
            .clone()
            .unwrap_or_else(|| format!("{}/oauth2/userinfo", self.issuer));
        let ui = self
            .fetch_json_with_auth(&userinfo_url, access_token)
            .await
            .map_err(|e| AuthError::new("invalid_token", e.message))?;
        if let Some(err) = ui.get("error").and_then(|v| v.as_str()) {
            return Err(AuthError::new(err, format!("令牌无效: {err}")));
        }
        identity_of(&ui)
    }

    /// 签发设备令牌。HS256 JWT，payload 带 userId 与 clientId。
    pub fn issue_device_token(
        &self,
        user_id: &str,
        client_id: &str,
        device_name: &str,
    ) -> Result<IssuedToken, AuthError> {
        if self.jwt_secret.is_empty() {
            return Err(AuthError::new("no_secret", "未配置 MN_WS_JWT_SECRET"));
        }
        let now = now_secs();
        let jti = random_hex(9);
        let payload = json!({
            "sub": user_id,
            "cid": client_id,
            "dn": device_name,
            "iat": now,
            "exp": now + DEVICE_TOKEN_TTL_SEC,
            // jti 让单枚令牌可被单独吊销
            "jti": jti,
        });
        let head = b64url_json(&json!({ "alg": "HS256", "typ": "JWT" }));
        let body = b64url_json(&payload);
        let sig = b64url(&sign_hmac(self.jwt_secret.as_bytes(), format!("{head}.{body}").as_bytes()));
        Ok(IssuedToken {
            token: format!("{head}.{body}.{sig}"),
            expires_at: (now + DEVICE_TOKEN_TTL_SEC) * 1000,
            jti,
        })
    }

    /// 校验设备令牌。返回 payload 或 `None`。
    pub fn verify_device_token(&self, token: &str) -> Option<DeviceTokenPayload> {
        if self.jwt_secret.is_empty() || token.is_empty() {
            return None;
        }
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() != 3 {
            return None;
        }
        let (head, body, sig) = (parts[0], parts[1], parts[2]);
        let want = b64url(&sign_hmac(
            self.jwt_secret.as_bytes(),
            format!("{head}.{body}").as_bytes(),
        ));
        // 常量时间比较：这里比的是「能不能冒充某个用户的一台桥」。
        if !constant_time_eq(sig.as_bytes(), want.as_bytes()) {
            return None;
        }
        let payload_bytes = from_b64url(body)?;
        let payload: Value = serde_json::from_slice(&payload_bytes).ok()?;
        let sub = payload.get("sub")?.as_str()?.to_string();
        let exp = payload.get("exp")?.as_i64()?;
        if now_secs() >= exp {
            return None;
        }
        let jti = payload.get("jti")?.as_str()?.to_string();
        if self.is_revoked(&jti) {
            return None;
        }
        Some(DeviceTokenPayload {
            sub,
            cid: payload
                .get("cid")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            dn: payload
                .get("dn")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            iat: payload.get("iat").and_then(|v| v.as_i64()).unwrap_or(0),
            exp,
            jti,
        })
    }

    /// 吊销某枚令牌。名单落盘 —— 否则重启即「全部恢复」，而吊销往往正是因为设备丢了。
    pub fn revoke(&self, jti: &str) {
        if jti.is_empty() {
            return;
        }
        let until = now_ms() + DEVICE_TOKEN_TTL_SEC * 1000;
        {
            let mut revoked = self.revoked.lock().unwrap();
            revoked.push((jti.to_string(), until));
        }
        self.save_devices();
    }

    fn is_revoked(&self, jti: &str) -> bool {
        if jti.is_empty() {
            return false;
        }
        let now = now_ms();
        let mut revoked = self.revoked.lock().unwrap();
        if let Some(pos) = revoked.iter().position(|(_, until)| *until < now) {
            revoked.retain(|(_, until)| *until >= now);
            let _ = pos;
        }
        revoked.iter().any(|(j, _)| j == jti)
    }

    /// 登记一台桥（client half）：clientId → 属主。永久一对一。
    pub fn register_device(
        &self,
        client_id: &str,
        user_id: &str,
        device_name: &str,
    ) -> Result<DeviceRecord, AuthError> {
        if client_id.is_empty() {
            return Err(AuthError::new("bad_request", "缺少 clientId"));
        }
        let mut devices = self.devices.lock().unwrap();
        if let Some(existing) = devices.iter().find(|d| d.client_id == client_id) {
            if existing.user_id != user_id {
                return Err(AuthError::new(
                    "device_owned_by_other",
                    "该标识已属于别的账号",
                ));
            }
        }
        let now = iso_now();
        let existing = devices.iter().find(|d| d.client_id == client_id).cloned();
        let rec = DeviceRecord {
            user_id: user_id.to_string(),
            client_id: client_id.to_string(),
            device_name: if !device_name.is_empty() {
                device_name.to_string()
            } else {
                existing
                    .as_ref()
                    .map(|e| e.device_name.clone())
                    .unwrap_or_default()
            },
            registered_at: existing
                .map(|e| e.registered_at)
                .unwrap_or_else(|| now.clone()),
            last_seen_at: now,
        };
        devices.retain(|d| d.client_id != client_id);
        devices.push(rec.clone());
        drop(devices);
        self.save_devices();
        Ok(rec)
    }

    /// 取一台设备。
    pub fn get_device(&self, client_id: &str) -> Option<DeviceRecord> {
        self.devices
            .lock()
            .unwrap()
            .iter()
            .find(|d| d.client_id == client_id)
            .cloned()
    }

    /// 某个用户名下的所有设备。
    pub fn devices_of(&self, user_id: &str) -> Vec<DeviceRecord> {
        self.devices
            .lock()
            .unwrap()
            .iter()
            .filter(|d| d.user_id == user_id)
            .cloned()
            .collect()
    }

    // ────────────────── 落盘 ──────────────────

    fn devices_file(&self) -> Option<PathBuf> {
        self.data_dir.as_ref().map(|d| d.join("devices.json"))
    }

    fn load_devices(&self) {
        let Some(f) = self.devices_file() else { return };
        let Ok(text) = std::fs::read_to_string(&f) else {
            return;
        };
        let Ok(raw) = serde_json::from_str::<Value>(&text) else {
            return;
        };
        let mut devices = self.devices.lock().unwrap();
        if let Some(map) = raw.get("devices").and_then(|v| v.as_object()) {
            for (k, v) in map {
                devices.push(DeviceRecord {
                    user_id: v
                        .get("userId")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                    client_id: v
                        .get("clientId")
                        .and_then(|x| x.as_str())
                        .unwrap_or(k)
                        .to_string(),
                    device_name: v
                        .get("deviceName")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                    registered_at: v
                        .get("registeredAt")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                    last_seen_at: v
                        .get("lastSeenAt")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                });
            }
        }
        let mut revoked = self.revoked.lock().unwrap();
        if let Some(map) = raw.get("revoked").and_then(|v| v.as_object()) {
            for (k, v) in map {
                revoked.push((k.clone(), v.as_i64().unwrap_or(0)));
            }
        }
    }

    fn save_devices(&self) {
        let Some(f) = self.devices_file() else { return };
        if let Some(dir) = f.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let mut devices = Map::new();
        for d in self.devices.lock().unwrap().iter() {
            devices.insert(
                d.client_id.clone(),
                json!({
                    "userId": d.user_id,
                    "clientId": d.client_id,
                    "deviceName": d.device_name,
                    "registeredAt": d.registered_at,
                    "lastSeenAt": d.last_seen_at,
                }),
            );
        }
        let mut revoked = Map::new();
        for (jti, until) in self.revoked.lock().unwrap().iter() {
            revoked.insert(jti.clone(), json!(until));
        }
        let payload = json!({ "devices": devices, "revoked": revoked });
        // 落盘失败不阻断主流程（与 TS 版一致）。
        let _ = std::fs::write(&f, serde_json::to_string_pretty(&payload).unwrap_or_default());
    }

    // ────────────────── HTTP ──────────────────

    async fn fetch_json(
        &self,
        url: &str,
        method: &str,
        content_type: Option<&str>,
        body: Option<Vec<u8>>,
    ) -> Result<Value, AuthError> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(self.http_timeout_ms))
            .build()
            .map_err(|e| AuthError::new("http_client", e.to_string()))?;
        let m = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|e| AuthError::new("bad_method", e.to_string()))?;
        let mut req = client.request(m, url);
        if let Some(ct) = content_type {
            req = req.header("Content-Type", ct);
        }
        if let Some(b) = body {
            req = req.body(b);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| AuthError::new("request_failed", e.to_string()))?;
        let text = resp
            .text()
            .await
            .map_err(|e| AuthError::new("read_failed", e.to_string()))?;
        // 非 JSON 就当原文（与 TS 版一致）。
        Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }

    async fn fetch_json_with_auth(&self, url: &str, access_token: &str) -> Result<Value, AuthError> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(self.http_timeout_ms))
            .build()
            .map_err(|e| AuthError::new("http_client", e.to_string()))?;
        let resp = client
            .get(url)
            .header("Authorization", format!("Bearer {access_token}"))
            .send()
            .await
            .map_err(|e| AuthError::new("request_failed", e.to_string()))?;
        let text = resp
            .text()
            .await
            .map_err(|e| AuthError::new("read_failed", e.to_string()))?;
        Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }
}

/// 从 userinfo 响应里取身份。
fn identity_of(ui: &Value) -> Result<Identity, AuthError> {
    let sub = ui
        .get("sub")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if sub.is_empty() {
        return Err(AuthError::new("no_sub", "userinfo 未返回 sub"));
    }
    Ok(Identity {
        user_id: sub.clone(),
        sub,
        email: ui.get("email").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        name: ui.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        preferred_username: ui
            .get("preferred_username")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// HMAC-SHA256 签名。
fn sign_hmac(secret: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC 接受任意长度的密钥");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// 常量时间比较（长度不等也算不等）。
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 现在的时间戳（秒）。
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 现在的时间戳（毫秒）。
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 随机十六进制串。
fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// URL 编码（form 风格）。
pub fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// ISO-8601 时间（复用 logger 的实现，避免两份）。
fn iso_now() -> String {
    crate::logger::iso_now()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hub() -> AuthHub {
        AuthHub::new(
            true,
            "http://idp.local",
            "mn-ws-server",
            "mn-ws-client",
            "http://127.0.0.1:1/callback",
            "test-secret",
            None,
        )
    }

    #[test]
    fn device_token_roundtrip() {
        let h = hub();
        let issued = h.issue_device_token("u1", "dev1", "我的机器").unwrap();
        let payload = h.verify_device_token(&issued.token).unwrap();
        assert_eq!(payload.sub, "u1");
        assert_eq!(payload.cid, "dev1");
        assert_eq!(payload.dn, "我的机器");
    }

    #[test]
    fn device_token_rejects_wrong_secret() {
        let h = hub();
        let issued = h.issue_device_token("u1", "dev1", "").unwrap();
        let other = AuthHub::new(
            true,
            "http://idp.local",
            "a",
            "b",
            "",
            "other-secret",
            None,
        );
        assert!(other.verify_device_token(&issued.token).is_none());
    }

    #[test]
    fn device_token_rejects_tampering() {
        let h = hub();
        let issued = h.issue_device_token("u1", "dev1", "").unwrap();
        let parts: Vec<&str> = issued.token.split('.').collect();
        let sig = parts[2];
        let last = sig.chars().last().unwrap();
        let other = if last == 'A' { 'B' } else { 'A' };
        let tampered_sig: String = format!("{}{}", &sig[..sig.len() - 1], other);
        let tampered = format!("{}.{}.{}", parts[0], parts[1], tampered_sig);
        assert_ne!(tampered, issued.token);
        assert!(h.verify_device_token(&tampered).is_none());
    }

    #[test]
    fn revoke_kills_the_token() {
        let h = hub();
        let issued = h.issue_device_token("u1", "dev1", "").unwrap();
        assert!(h.verify_device_token(&issued.token).is_some());
        h.revoke(&issued.jti);
        assert!(h.verify_device_token(&issued.token).is_none());
    }

    #[test]
    fn device_binding_is_permanent() {
        let h = hub();
        h.register_device("dev1", "u1", "").unwrap();
        // 换绑保护：一台 clientId 只能属一个用户
        let err = h.register_device("dev1", "u2", "").unwrap_err();
        assert_eq!(err.code, "device_owned_by_other");
        assert!(err.message.contains("属于别的账号"));
    }

    #[test]
    fn public_config_never_leaks_secret() {
        let h = hub();
        let cfg = h.public_config();
        assert_eq!(cfg.client_id, "mn-ws-server");
        assert_eq!(cfg.login_client_id, "mn-ws-client");
        assert!(!cfg.idp_available, "没拉过发现文档就是不可用");
    }

    #[test]
    fn b64url_roundtrip() {
        let data = b"hello \xe4\xb8\x96\xe7\x95\x8c";
        let enc = b64url(data);
        assert!(!enc.contains('='));
        assert_eq!(from_b64url(&enc).unwrap(), data);
    }
}
