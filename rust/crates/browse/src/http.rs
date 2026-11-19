//! A tiny blocking HTTP/1.1 client for the local relay. The relay is always on loopback, so no TLS, no pooling.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

pub enum Error {
    /// Nothing accepted the connection: the request was never sent.
    Unreachable(io::Error),
    /// The request may have reached the server.
    Io(io::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Unreachable(e) | Error::Io(e) => e.fmt(f),
        }
    }
}

pub fn request(
    endpoint: &str,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
    timeout: Option<Duration>,
) -> Result<Response, Error> {
    Connection::open(endpoint)?.send(method, path, headers, body, timeout, true)
}

/// One connection to the relay, kept open between requests: every request on it reaches the process that answered
/// the first one, so a reader that checked that process's `/version` knows who gets the rest.
pub struct Connection {
    authority: String,
    reader: BufReader<TcpStream>,
}

impl Connection {
    pub fn open(endpoint: &str) -> Result<Self, Error> {
        let authority = endpoint.trim_start_matches("http://").trim_end_matches('/').to_owned();
        let addr = authority
            .to_socket_addrs()
            .map_err(Error::Unreachable)?
            .next()
            .ok_or_else(|| Error::Unreachable(io::Error::other("no address")))?;
        let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(Error::Unreachable)?;
        stream.set_nodelay(true).ok();
        Ok(Self { authority, reader: BufReader::new(stream) })
    }

    /// One request on this connection; `close` asks the server to close it after answering.
    pub fn send(
        &mut self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<&[u8]>,
        timeout: Option<Duration>,
        close: bool,
    ) -> Result<Response, Error> {
        let stream = self.reader.get_mut();
        stream.set_read_timeout(timeout).map_err(Error::Io)?;
        let body = body.unwrap_or_default();
        let connection = if close { "close" } else { "keep-alive" };
        let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {}\r\nConnection: {connection}\r\nAccept: application/json\r\n", self.authority);
        for (name, value) in headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        if method != "GET" {
            head.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", body.len()));
        }
        head.push_str("\r\n");
        stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(body)).map_err(Error::Io)?;
        read_response(&mut self.reader).map_err(Error::Io)
    }
}

fn read_response(reader: &mut BufReader<TcpStream>) -> io::Result<Response> {
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let status = line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "not an HTTP response"))?;
    let (mut length, mut chunked) = (None, false);
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        let Some((name, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            length = value.parse::<usize>().ok();
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            chunked = value.eq_ignore_ascii_case("chunked");
        }
    }
    let mut body = Vec::new();
    if chunked {
        loop {
            line.clear();
            reader.read_line(&mut line)?;
            let size = usize::from_str_radix(line.trim().split(';').next().unwrap_or(""), 16)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad chunk"))?;
            if size == 0 {
                break;
            }
            let start = body.len();
            body.resize(start + size, 0);
            reader.read_exact(&mut body[start..])?;
            reader.read_line(&mut line)?;
        }
    } else if let Some(length) = length {
        body.resize(length, 0);
        reader.read_exact(&mut body)?;
    } else {
        reader.read_to_end(&mut body)?;
    }
    Ok(Response { status, body })
}
