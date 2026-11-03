//! 把前端单文件产物嵌进二进制。还没构建前端时放一个说明页，后端也能单独编译。

use std::path::Path;

fn main() {
    let dist = Path::new("../dist/index.html");
    println!("cargo:rerun-if-changed=../dist/index.html");
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("ui.html");
    let html = std::fs::read_to_string(dist).unwrap_or_else(|_| {
        "<!doctype html><meta charset=utf-8><title>Localhost Observatory</title>\
         <p>前端还没有构建。先在项目根目录运行 <code>npm run build</code>，再重新编译后端。</p>"
            .to_string()
    });
    std::fs::write(out, html).unwrap();
}
