// JSON-lines adapter for exercising the production Rust service with the existing fixtures.
use danmaku_media::{describe, MediaServer};
use serde_json::{json, Value};
use std::{
    io::{self, Write},
    path::Path,
};
use tokio::io::{AsyncBufReadExt, BufReader};

fn reply(id: &Value, result: Result<Value, String>) {
    let value = match result {
        Ok(value) => json!({"id": id, "value": value}),
        Err(error) => json!({"id": id, "error": error}),
    };
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{value}").unwrap();
}

#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().collect();
    let server = MediaServer::start(args[1].clone().into(), args[2].clone().into(), |error| {
        let mut stdout = io::stdout().lock();
        writeln!(stdout, "{}", json!({"event": "error", "value": error})).unwrap();
    })
    .await
    .unwrap();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let request: Value = serde_json::from_str(&line).unwrap();
        let id = request["id"].clone();
        match request["method"].as_str().unwrap() {
            "prepare" => {
                let server = server.clone();
                // Let requests overlap so cancellation is tested too.
                tokio::spawn(async move {
                    let result = server
                        .prepare(
                            Path::new(request["path"].as_str().unwrap()),
                            request["force"].as_bool().unwrap_or(false),
                        )
                        .await;
                    reply(
                        &id,
                        result.map(|value| serde_json::to_value(value).unwrap()),
                    );
                });
                tokio::task::yield_now().await;
            }
            "describe" => reply(
                &id,
                describe(
                    &request["probe"],
                    Path::new(request["path"].as_str().unwrap()),
                    request["force"].as_bool().unwrap_or(false),
                )
                .map(|value| serde_json::to_value(value).unwrap()),
            ),
            "release" => {
                server.release();
                reply(&id, Ok(Value::Null));
            }
            "close" => {
                server.close();
                reply(&id, Ok(Value::Null));
                break;
            }
            _ => reply(&id, Err("Unknown method".into())),
        }
    }
    server.close();
}
