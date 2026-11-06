//! Containers.
//!
//! Six of them, with the mix a small fleet actually has: a few things that
//! stay up, one that exited non-zero and one that was created and never
//! started. State changes stick and push container.changed, and
//! `container.exec` drops into the same fake shell the terminal uses,
//! rooted in the container's own tiny filesystem rather than the host's.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::files::{self, FsRef};
use super::logs::{self, TailRequest};
use super::pty::PtySession;
use super::services::{bring_down, bring_up, find_unit};
use super::state::{GIB, MIB, Sim, World, clampf, drift, hash_string, human_duration, mix, round2, stamp};
use crate::providers::{
    ContainerExecParams, ContainerInfo, ContainerInspectResult, ContainerListParams, ContainerLogsParams,
    ContainerMount, ContainerPort, ContainerPruneParams, ContainerPruneResult, ContainerRemoveParams,
    ContainerStopParams, Containers, Ctx, ImageInfo, LogRecord, PResult, ProviderError, StreamRef, topic,
};

pub struct Container {
    pub info: ContainerInfo,
    pub process: String,
    pub process_args: String,
    pub process_user: String,
    pub rss_base: i64,
    pub mem_limit: i64,
    pub cpu_base: f64,
    pub fs: Option<FsRef>,
}

struct ContainerSeed {
    name: &'static str,
    image: &'static str,
    state: &'static str,
    age_days: i64,
    ports: Vec<ContainerPort>,
    labels: Vec<(&'static str, &'static str)>,
    networks: Vec<&'static str>,
    mounts: Vec<ContainerMount>,
    process: &'static str,
    process_args: &'static str,
    process_user: &'static str,
    rss: i64,
    mem_limit: i64,
    cpu: f64,
    exit_code: i64,
    restarts: i64,
}

fn tcp(host: i64, guest: i64) -> ContainerPort {
    ContainerPort { container_port: guest, host_port: Some(host), host_ip: Some("0.0.0.0".into()), protocol: "tcp".into() }
}

fn mount(source: &str, destination: &str, rw: bool) -> ContainerMount {
    ContainerMount { source: source.into(), destination: destination.into(), rw }
}

fn catalogue() -> Vec<ContainerSeed> {
    vec![
        ContainerSeed {
            name: "kaname-redis",
            image: "redis:7-alpine",
            state: "running",
            age_days: 41,
            ports: vec![tcp(6379, 6379)],
            labels: vec![("com.docker.compose.project", "kaname"), ("com.docker.compose.service", "redis")],
            networks: vec!["kaname_default"],
            mounts: vec![mount("/var/lib/docker/volumes/kaname_redis/_data", "/data", true)],
            process: "redis-server",
            process_args: "redis-server *:6379",
            process_user: "systemd-network",
            rss: 38 * MIB,
            mem_limit: 512 * MIB,
            cpu: 0.9,
            exit_code: 0,
            restarts: 0,
        },
        ContainerSeed {
            name: "kaname-minio",
            image: "minio/minio:RELEASE.2024-06-13T22-53-53Z",
            state: "running",
            age_days: 41,
            ports: vec![tcp(9000, 9000), tcp(9001, 9001)],
            labels: vec![("com.docker.compose.project", "kaname"), ("com.docker.compose.service", "minio")],
            networks: vec!["kaname_default"],
            mounts: vec![mount("/srv/minio", "/data", true)],
            process: "minio",
            process_args: "minio server /data --console-address :9001",
            process_user: "root",
            rss: 214 * MIB,
            mem_limit: 2 * GIB,
            cpu: 2.4,
            exit_code: 0,
            restarts: 0,
        },
        ContainerSeed {
            name: "pgbouncer",
            image: "edoburu/pgbouncer:1.22.1",
            state: "running",
            age_days: 26,
            ports: vec![tcp(6432, 5432)],
            labels: vec![("com.docker.compose.project", "kaname"), ("com.docker.compose.service", "pgbouncer")],
            networks: vec!["kaname_default"],
            mounts: vec![mount("/etc/pgbouncer", "/etc/pgbouncer", false)],
            process: "pgbouncer",
            process_args: "/usr/sbin/pgbouncer /etc/pgbouncer/pgbouncer.ini",
            process_user: "postgres",
            rss: 26 * MIB,
            mem_limit: 256 * MIB,
            cpu: 0.5,
            exit_code: 0,
            restarts: 0,
        },
        ContainerSeed {
            name: "uptime-kuma",
            image: "louislam/uptime-kuma:1.23.13",
            state: "running",
            age_days: 63,
            ports: vec![tcp(3001, 3001)],
            labels: vec![("maintainer", "louislam")],
            networks: vec!["bridge"],
            mounts: vec![mount("/srv/uptime-kuma", "/app/data", true)],
            process: "node",
            process_args: "node server/server.js",
            process_user: "root",
            rss: 176 * MIB,
            mem_limit: GIB,
            cpu: 1.7,
            exit_code: 0,
            restarts: 3,
        },
        ContainerSeed {
            name: "n8n",
            image: "n8nio/n8n:1.45.1",
            state: "exited",
            age_days: 12,
            ports: vec![tcp(5678, 5678)],
            labels: vec![("com.docker.compose.project", "automation"), ("com.docker.compose.service", "n8n")],
            networks: vec!["automation_default"],
            mounts: vec![mount("/srv/n8n", "/home/node/.n8n", true)],
            process: "node",
            process_args: "node /usr/local/bin/n8n start",
            process_user: "node",
            rss: 0,
            mem_limit: GIB,
            cpu: 0.0,
            exit_code: 137,
            restarts: 2,
        },
        ContainerSeed {
            name: "watchtower",
            image: "containrrr/watchtower:1.7.1",
            state: "created",
            age_days: 3,
            ports: vec![],
            labels: vec![("com.centurylinklabs.watchtower", "true")],
            networks: vec!["bridge"],
            mounts: vec![mount("/var/run/docker.sock", "/var/run/docker.sock", false)],
            process: "watchtower",
            process_args: "/watchtower --cleanup --interval 3600",
            process_user: "root",
            rss: 0,
            mem_limit: 128 * MIB,
            cpu: 0.0,
            exit_code: 0,
            restarts: 0,
        },
    ]
}

const IMAGE_CATALOGUE: &[(&str, i64, i64, bool)] = &[
    ("redis:7-alpine", 41 * MIB, 45, true),
    ("minio/minio:RELEASE.2024-06-13T22-53-53Z", 178 * MIB, 45, true),
    ("edoburu/pgbouncer:1.22.1", 24 * MIB, 30, true),
    ("louislam/uptime-kuma:1.23.13", 462 * MIB, 70, true),
    ("n8nio/n8n:1.45.1", 703 * MIB, 14, true),
    ("containrrr/watchtower:1.7.1", 17 * MIB, 6, true),
    ("postgres:16-alpine", 254 * MIB, 118, false),
    ("<none>:<none>", 512 * MIB, 132, false),
    ("nginx:1.27-alpine", 48 * MIB, 91, false),
];

fn digest(seed: u64, i: u64, a: u64, b: u64, c: u64, d: u64) -> String {
    format!(
        "{:016x}{:016x}{:016x}{:016x}",
        mix(seed ^ i ^ a),
        mix(seed ^ i ^ b),
        mix(seed ^ i ^ c),
        mix(seed ^ i ^ d)
    )
}

pub fn build_containers(sim: &Sim) {
    let now = Utc::now();
    let mut w = sim.world.lock();

    w.containers = catalogue()
        .into_iter()
        .enumerate()
        .map(|(i, seed)| {
            let i = i as u64;
            let id = digest(sim.seed, i, 0xc1, 0xc2, 0xc3, 0xc4);
            let created = now - chrono::Duration::days(seed.age_days);

            let mut info = ContainerInfo {
                id,
                name: seed.name.into(),
                image: seed.image.into(),
                image_id: format!("sha256:{}", digest(sim.seed, i, 0xd1, 0xd2, 0xd3, 0xd4)),
                state: seed.state.into(),
                status: String::new(),
                created_at: stamp(created),
                started_at: None,
                ports: seed.ports,
                labels: seed.labels.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<BTreeMap<_, _>>(),
                networks: seed.networks.iter().map(|n| n.to_string()).collect(),
                mounts: seed.mounts,
                restart_count: seed.restarts,
                cpu_percent: None,
                memory_usage: None,
                memory_limit: Some(seed.mem_limit),
                runtime: "docker".into(),
            };

            match seed.state {
                "running" => {
                    let started = created + chrono::Duration::seconds((mix(sim.seed ^ i ^ 0xe1) % 3600) as i64);
                    info.started_at = Some(stamp(started));
                    info.status = format!("Up {}", human_duration(now - started));
                }
                "exited" => {
                    let stopped = now - chrono::Duration::hours(2 + (mix(sim.seed ^ i ^ 0xe2) % 40) as i64);
                    info.started_at = Some(stamp(created));
                    info.status = format!("Exited ({}) {} ago", seed.exit_code, human_duration(now - stopped));
                }
                _ => info.status = "Created".into(),
            }

            Container {
                info,
                process: seed.process.into(),
                process_args: seed.process_args.into(),
                process_user: seed.process_user.into(),
                rss_base: seed.rss,
                mem_limit: seed.mem_limit,
                cpu_base: seed.cpu,
                fs: None,
            }
        })
        .collect();

    w.images = IMAGE_CATALOGUE
        .iter()
        .enumerate()
        .map(|(i, (tag, size, age_days, in_use))| ImageInfo {
            id: format!("sha256:{}", digest(sim.seed, i as u64, 0xf1, 0xf2, 0xf3, 0xf4)),
            tags: vec![tag.to_string()],
            size: *size,
            created_at: stamp(now - chrono::Duration::days(*age_days)),
            in_use: *in_use,
        })
        .collect();
}

pub fn find_container(w: &World, id: &str) -> Option<usize> {
    w.containers
        .iter()
        .position(|c| c.info.id == id || c.info.name == id || (!id.is_empty() && c.info.id.starts_with(id)))
}

/// Fills the two columns that only mean anything while the container is up.
fn with_stats(sim: &Sim, c: &Container, now: DateTime<Utc>) -> ContainerInfo {
    let mut info = c.info.clone();
    if info.state != "running" {
        return info;
    }
    let t = now.timestamp_millis() as f64 / 1000.0;
    let seed = sim.seed ^ hash_string(&c.info.id);
    info.cpu_percent = Some(round2(clampf(c.cpu_base * (1.0 + 1.6 * drift(seed, t / 40.0, 2)), 0.0, 100.0)));
    info.memory_usage = Some((c.rss_base as f64 * (1.0 + 0.14 * drift(seed ^ 0x3, t / 300.0, 2))) as i64);
    info
}

/// Rebuilds containerd's process set so the host process table always
/// agrees with the container table.
pub fn respawn_containerd(sim: &Sim, w: &mut World) {
    let Some(idx) = find_unit(w, "containerd.service") else { return };
    if w.units[idx].info.active_state != "active" {
        return;
    }
    bring_down(w, idx, "inactive", "dead");
    bring_up(sim, w, idx, Utc::now());
}

/// Where the statefulness lives: the container's shim and main process
/// join or leave the host process table with it.
fn set_container_state(sim: &Sim, id: &str, state: &str) -> PResult<ContainerInfo> {
    let now = Utc::now();
    let info = {
        let mut w = sim.world.lock();
        let Some(idx) = find_container(&w, id) else {
            return Err(ProviderError::not_found(format!("container {id}")));
        };
        if w.containers[idx].info.state == state {
            return Ok(w.containers[idx].info.clone());
        }
        {
            let c = &mut w.containers[idx];
            c.info.state = state.into();
            match state {
                "running" => {
                    c.info.started_at = Some(stamp(now));
                    c.info.status = "Up 1 seconds".into();
                }
                "exited" => {
                    c.info.status = "Exited (0) 0 seconds ago".into();
                    c.info.cpu_percent = None;
                    c.info.memory_usage = None;
                }
                _ => {}
            }
        }
        respawn_containerd(sim, &mut w);
        w.containers[idx].info.clone()
    };

    sim.emit(
        topic::CONTAINER_CHANGED,
        serde_json::json!({"container_id": info.id, "name": info.name, "state": info.state}),
    );
    Ok(info)
}

pub struct SimContainers(pub Arc<Sim>);

#[async_trait]
impl Containers for SimContainers {
    async fn list(&self, _ctx: &Ctx, p: ContainerListParams) -> PResult<Vec<ContainerInfo>> {
        let now = Utc::now();
        let w = self.0.world.lock();
        let mut out: Vec<ContainerInfo> = w
            .containers
            .iter()
            .filter(|c| p.all || c.info.state == "running")
            .map(|c| if p.with_stats { with_stats(&self.0, c, now) } else { c.info.clone() })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    async fn inspect(&self, _ctx: &Ctx, id: &str) -> PResult<ContainerInspectResult> {
        let now = Utc::now();
        let w = self.0.world.lock();
        let Some(idx) = find_container(&w, id) else {
            return Err(ProviderError::not_found(format!("container {id}")));
        };
        let c = &w.containers[idx];
        let info = with_stats(&self.0, c, now);
        let mut fields = c.process_args.split_whitespace();
        let path = fields.next().unwrap_or_default().to_string();
        let args: Vec<String> = fields.map(str::to_string).collect();

        let raw = serde_json::json!({
            "Id": info.id,
            "Name": format!("/{}", info.name),
            "Created": info.created_at,
            "Path": path,
            "Args": args,
            "State": {
                "Status": info.state,
                "Running": info.state == "running",
                "Pid": 0,
                "StartedAt": info.started_at,
                "RestartCount": info.restart_count,
            },
            "Image": info.image_id,
            "Config": {
                "Hostname": &info.id[..12],
                "Image": info.image,
                "Labels": info.labels,
                "Env": ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
            },
            "HostConfig": {
                "RestartPolicy": {"Name": "unless-stopped"},
                "Memory": c.mem_limit,
                "NetworkMode": info.networks.first().cloned().unwrap_or_default(),
            },
            "Mounts": info.mounts,
        });
        Ok(ContainerInspectResult { container: info, raw })
    }

    async fn start(&self, _ctx: &Ctx, id: &str) -> PResult<ContainerInfo> {
        set_container_state(&self.0, id, "running")
    }

    async fn stop(&self, _ctx: &Ctx, p: ContainerStopParams) -> PResult<ContainerInfo> {
        set_container_state(&self.0, &p.id, "exited")
    }

    async fn restart(&self, _ctx: &Ctx, p: ContainerStopParams) -> PResult<ContainerInfo> {
        set_container_state(&self.0, &p.id, "exited")?;
        let mut info = set_container_state(&self.0, &p.id, "running")?;
        let mut w = self.0.world.lock();
        if let Some(idx) = find_container(&w, &p.id) {
            w.containers[idx].info.restart_count += 1;
            info = w.containers[idx].info.clone();
        }
        Ok(info)
    }

    async fn remove(&self, _ctx: &Ctx, p: ContainerRemoveParams) -> PResult<()> {
        let (id, name) = {
            let mut w = self.0.world.lock();
            let Some(idx) = find_container(&w, &p.id) else {
                return Err(ProviderError::not_found(format!("container {}", p.id)));
            };
            if w.containers[idx].info.state == "running" && !p.force {
                return Err(ProviderError::conflict(format!("container {} is running", w.containers[idx].info.name)));
            }
            let target = w.containers.remove(idx);
            respawn_containerd(&self.0, &mut w);
            (target.info.id, target.info.name)
        };
        self.0.emit(
            topic::CONTAINER_CHANGED,
            serde_json::json!({"container_id": id, "name": name, "state": "removed"}),
        );
        Ok(())
    }

    async fn logs(&self, ctx: &Ctx, p: ContainerLogsParams, s: StreamRef) -> PResult<Vec<LogRecord>> {
        let name = {
            let w = self.0.world.lock();
            let Some(idx) = find_container(&w, &p.id) else {
                return Err(ProviderError::not_found(format!("container {}", p.id)));
            };
            w.containers[idx].info.name.clone()
        };
        logs::tail(
            &self.0,
            ctx,
            &*s,
            TailRequest {
                source: logs::SOURCE_CONTAINER.into(),
                container: name,
                lines: p.lines,
                follow: p.follow,
                since: p.since,
                ..Default::default()
            },
        )
        .await
    }

    async fn exec(&self, ctx: &Ctx, p: ContainerExecParams, s: StreamRef) -> PResult<()> {
        let (fs, prompt) = {
            let mut w = self.0.world.lock();
            let Some(idx) = find_container(&w, &p.id) else {
                return Err(ProviderError::not_found(format!("container {}", p.id)));
            };
            if w.containers[idx].info.state != "running" {
                return Err(ProviderError::PreconditionFailed(format!(
                    "container {} is not running",
                    w.containers[idx].info.name
                )));
            }
            if w.containers[idx].fs.is_none() {
                let fs = files::build_container_filesystem(&w.containers[idx]);
                w.containers[idx].fs = Some(fs);
            }
            let c = &w.containers[idx];
            (c.fs.clone().expect("container filesystem"), format!("root@{}", &c.info.id[..12]))
        };

        let session = PtySession::new(self.0.clone(), fs, &prompt, "/", p.cols, p.rows);
        session.run(ctx, &*s).await.map(|_| ())
    }

    async fn images(&self, _ctx: &Ctx) -> PResult<Vec<ImageInfo>> {
        Ok(self.0.world.lock().images.clone())
    }

    async fn prune(&self, _ctx: &Ctx, p: ContainerPruneParams) -> PResult<ContainerPruneResult> {
        let mut w = self.0.world.lock();
        let mut removed = Vec::new();
        let mut reclaimed: i64 = 0;

        let containers = std::mem::take(&mut w.containers);
        for c in containers {
            if c.info.state == "exited" {
                removed.push(c.info.id.clone());
                reclaimed += c.rss_base + 64 * MIB;
            } else {
                w.containers.push(c);
            }
        }

        if p.include_images {
            let images = std::mem::take(&mut w.images);
            for image in images {
                if !image.in_use {
                    removed.push(image.id.clone());
                    reclaimed += image.size;
                } else {
                    w.images.push(image);
                }
            }
        }
        if p.include_volumes {
            reclaimed += 1_284_374_528;
            removed.push("kaname_redis_stale".into());
            removed.push("automation_n8n_old".into());
        }

        respawn_containerd(&self.0, &mut w);
        Ok(ContainerPruneResult { reclaimed_bytes: reclaimed, removed })
    }
}
