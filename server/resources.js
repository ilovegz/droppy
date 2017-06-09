"use strict";

const resources    = module.exports = {};
const async        = require("async");
const etag         = require("etag");
const fs           = require("graceful-fs");
const jb           = require("json-buffer");
const mkdirp       = require("mkdirp");
const path         = require("path");
const vm           = require("vm");
const zlib         = require("zlib");

const log          = require("./log.js");
const paths        = require("./paths.js").get();
const utils        = require("./utils.js");

const themesPath   = path.join(paths.mod, "/node_modules/codemirror/theme");
const modesPath    = path.join(paths.mod, "/node_modules/codemirror/mode");
const cachePath    = path.join(paths.mod, "dist", "cache.json");

let minify;

const opts = {
  uglify: {
    mangle: true,
    compress: {
      booleans: true,
      cascade: true,
      collapse_vars: true,
      conditionals: true,
      comparisons: true,
      dead_code: true,
      keep_fargs: false,
      drop_debugger: true,
      evaluate: true,
      hoist_funs: true,
      if_return: true,
      negate_iife: true,
      join_vars: true,
      loops: true,
      properties: true,
      reduce_vars: true,
      sequences: true,
      toplevel: true,
      unsafe: true,
      unsafe_proto: true,
      unused: true,
    },
  },
  cleanCSS: {
    level: {
      1: {
        specialComments : 0,
      },
      2: {
        all: false,
        mergeMedia: true,
        removeDuplicateMediaBlocks: true,
        removeDuplicateRules: true,
      },
    },
    rebase: false,
  },
  autoprefixer: {
    cascade: false,
  },
  htmlMinifier: {
    caseSensitive: true,
    collapseBooleanAttributes: true,
    collapseInlineTagWhitespace: true,
    collapseWhitespace: true,
    customAttrSurround: [[/{{#.+?}}/, /{{\/.+?}}/]],
    decodeEntities: true,
    ignoreCustomComments: [],
    ignoreCustomFragments: [/{{[\s\S]*?}}/],
    includeAutoGeneratedTags: false,
    minifyCSS: {
      specialComments : 0,
      rebase: false,
    },
    removeAttributeQuotes: true,
    removeComments: true,
    removeOptionalTags: true,
    removeRedundantAttributes: true,
    removeTagWhitespace: true,
  },
  brotli: {
    mode: 1,
    quality: 11,
    lgwin: 22,
    lgblock: 0,
  }
};

let autoprefixer, cleanCSS, postcss, uglify, htmlMinifier, zopfli, brotli, svg, handlebars;
try {
  autoprefixer = require("autoprefixer");
  brotli       = require("iltorb").compress;
  cleanCSS     = new (require("clean-css"))(opts.cleanCSS);
  handlebars   = require("handlebars");
  htmlMinifier = require("html-minifier");
  postcss      = require("postcss");
  uglify       = require("uglify-js");
  zopfli       = require("node-zopfli");
  svg          = require("./svg.js");
} catch (err) {}

resources.files = {
  css: [
    "client/style.css",
    "client/sprites.css",
    "client/tooltips.css",
  ],
  js: [
    "node_modules/handlebars/dist/handlebars.runtime.min.js",
    "node_modules/file-extension/file-extension.js",
    "node_modules/screenfull/dist/screenfull.js",
    "node_modules/mousetrap/mousetrap.min.js",
    "node_modules/whatwg-fetch/fetch.js",
    "node_modules/uppie/uppie.js",
    "client/jquery-custom.min.js",
    "client/client.js",
  ],
  other: [
    "client/font.woff",
    "client/images/logo.svg",
    "client/images/logo32.png",
    "client/images/logo120.png",
    "client/images/logo128.png",
    "client/images/logo152.png",
    "client/images/logo180.png",
    "client/images/logo192.png",
    "client/images/sprites.png",
  ]
};

// On-demand loadable libs. Will be available as !/res/lib/[prop]
const libs = {
  // plyr
  "plyr.js": "node_modules/plyr/src/js/plyr.js",
  "plyr.css": "node_modules/plyr/dist/plyr.css",
  "plyr.svg": "node_modules/plyr/dist/plyr.svg",
  "blank.mp4": "client/blank.mp4",
  // codemirror
  "cm.js": [
    "node_modules/codemirror/lib/codemirror.js",
    "node_modules/codemirror/mode/meta.js",
    "node_modules/codemirror/addon/mode/overlay.js",
    "node_modules/codemirror/addon/dialog/dialog.js",
    "node_modules/codemirror/addon/selection/active-line.js",
    "node_modules/codemirror/addon/selection/mark-selection.js",
    "node_modules/codemirror/addon/search/searchcursor.js",
    "node_modules/codemirror/addon/edit/matchbrackets.js",
    "node_modules/codemirror/addon/search/search.js",
    "node_modules/codemirror/keymap/sublime.js"
  ],
  "cm.css": "node_modules/codemirror/lib/codemirror.css",
  // photoswipe
  "ps.js": [
    "node_modules/photoswipe/dist/photoswipe.min.js",
    "node_modules/photoswipe/dist/photoswipe-ui-default.min.js",
  ],
  "ps.css": [
    "node_modules/photoswipe/dist/photoswipe.css",
    "node_modules/photoswipe/dist/default-skin/default-skin.css",
  ],
  // photoswipe skin files included by their CSS
  "default-skin.png": "node_modules/photoswipe/dist/default-skin/default-skin.png",
  "default-skin.svg": "node_modules/photoswipe/dist/default-skin/default-skin.svg",
};

resources.load = function(dev, cb) {
  minify = !dev;

  if (dev) return compile(false, cb);
  fs.readFile(cachePath, function(err, data) {
    if (err) {
      log.info(err.code, " ", cachePath, ", ", "building cache ...");
      return compile(true, cb);
    }
    try {
      cb(null, jb.parse(data));
    } catch (err) {
      log.error(err);
      compile(false, cb);
    }
  });
};

resources.build = function(cb) {
  isCacheFresh(function(fresh) {
    if (fresh) {
      fs.readFile(cachePath, function(err, data) {
        if (err) return compile(true, cb);
        try {
          jb.parse(data);
          cb(null);
        } catch (err) {
          compile(true, cb);
        }
      });
    } else {
      minify = true;
      compile(true, cb);
    }
  });
};

// compat: Node.js < 6
function buf(str) {
  return "from" in Buffer ? Buffer.from(str) : Buffer(str);
}

function isCacheFresh(cb) {
  fs.stat(cachePath, function(err, stats) {
    if (err) return cb(false);
    const files = [];
    Object.keys(resources.files).forEach(function(type) {
      resources.files[type].forEach(function(file) {
        files.push(path.join(paths.mod, file));
      });
    });
    Object.keys(libs).forEach(function(file) {
      if (typeof libs[file] === "string") {
        files.push(path.join(paths.mod, libs[file]));
      } else {
        libs[file].forEach(function(file) {
          files.push(path.join(paths.mod, file));
        });
      }
    });
    async.map(files, function(file, cb) {
      fs.stat(file, function(err, stats) {
        cb(null, err ? 0 : stats.mtime.getTime());
      });
    }, function(_, times) {
      cb(stats.mtime.getTime() >= Math.max.apply(Math, times));
    });
  });
}

function compile(write, cb) {
  if (!autoprefixer) {
    return cb(new Error("Missing devDependencies to compile resource cache, " +
                        "please reinstall or run `npm install --only=dev` inside the project directory"));
  }
  async.series([compileAll, readThemes, readModes, readLibs], function(err, results) {
    if (err) return cb(err);
    const cache = {res: results[0], themes: {}, modes: {}, lib: {}};

    Object.keys(results[1]).forEach(function(theme) {
      cache.themes[theme] = {
        data: results[1][theme],
        etag: etag(results[1][theme]),
        mime: utils.contentType("css"),
      };
    });

    Object.keys(results[2]).forEach(function(mode) {
      cache.modes[mode] = {
        data: results[2][mode],
        etag: etag(results[2][mode]),
        mime: utils.contentType("js"),
      };
    });

    Object.keys(results[3]).forEach(function(file) {
      cache.lib[file] = {
        data: results[3][file],
        etag: etag(results[3][file]),
        mime: utils.contentType(file),
      };
    });

    addGzip(cache, function(err, cache) {
      if (err) return cb(err);
      addBrotli(cache, function(err, cache) {
        if (err) return cb(err);
        if (write) {
          mkdirp(path.dirname(cachePath), function(err) {
            if (err) return cb(err);
            fs.writeFile(cachePath, jb.stringify(cache), function(err) {
              cb(err, cache);
            });
          });
        } else cb(null, cache);
      });
    });
  });
}

// Create gzip compressed data
function addGzip(cache, callback) {
  const types = Object.keys(cache), funcs = [];
  types.forEach(function(type) {
    funcs.push(function(cb) {
      gzipMap(cache[type], cb);
    });
  });
  async.parallel(funcs, function(err, results) {
    if (err) return callback(err);
    types.forEach(function(type, index) {
      cache[type] = results[index];
    });
    callback(null, cache);
  });
}

function gzipMap(map, callback) {
  const names = Object.keys(map), funcs = [];
  names.forEach(function(name) {
    funcs.push(function(cb) {
      (minify ? zopfli : zlib).gzip(map[name].data, cb);
    });
  });
  async.parallel(funcs, function(err, results) {
    if (err) return callback(err);
    names.forEach(function(name, index) {
      map[name].gzip = results[index];
    });
    callback(null, map);
  });
}

// Create brotli compressed data
function addBrotli(cache, callback) {
  const types = Object.keys(cache), funcs = [];
  types.forEach(function(type) {
    funcs.push(function(cb) {
      brotliMap(cache[type], cb);
    });
  });
  async.parallel(funcs, function(err, results) {
    if (err) return callback(err);
    types.forEach(function(type, index) {
      cache[type] = results[index];
    });
    callback(null, cache);
  });
}

function brotliMap(map, callback) {
  const names = Object.keys(map), funcs = [];
  names.forEach(function(name) {
    funcs.push(function(cb) {
      brotli(map[name].data, opts.brotli, cb);
    });
  });
  async.parallel(funcs, function(err, results) {
    if (err) return callback(err);
    names.forEach(function(name, index) {
      map[name].brotli = results[index];
    });
    callback(null, map);
  });
}

function readThemes(callback) {
  const themes = {};
  fs.readdir(themesPath, function(err, filenames) {
    if (err) return callback(err);

    const files = filenames.map(function(name) {
      return path.join(themesPath, name);
    });

    async.map(files, fs.readFile, function(err, data) {
      if (err) return callback(err);

      filenames.forEach(function(name, index) {
        const css = String(data[index]);
        themes[name.replace(/\.css$/, "")] = buf(minifyCSS(css));
      });

      // add our own theme
      fs.readFile(path.join(paths.mod, "/client/cmtheme.css"), function(err, css) {
        css = String(css);
        if (err) return callback(err);
        themes.droppy = buf(minifyCSS(css));
        callback(null, themes);
      });
    });
  });
}

function readModes(callback) {
  const modes = {};

  // parse meta.js from CM for supported modes
  fs.readFile(path.join(paths.mod, "/node_modules/codemirror/mode/meta.js"), function(err, js) {
    if (err) return callback(err);

    // Extract modes from CodeMirror
    const sandbox = {CodeMirror : {}};
    vm.runInNewContext(js, sandbox);
    sandbox.CodeMirror.modeInfo.forEach(function(entry) {
      if (entry.mode !== "null") modes[entry.mode] = null;
    });

    async.map(Object.keys(modes), function(mode, cb) {
      fs.readFile(path.join(modesPath, mode, mode + ".js"), function(err, data) {
        cb(err, buf(minifyJS(String(data))));
      });
    }, function(err, result) {
      Object.keys(modes).forEach(function(mode, i) {
        modes[mode] = result[i];
      });
      callback(err, modes);
    });
  });
}

function readLibs(callback) {
  const out = {};
  async.each(Object.keys(libs), function(dest, cb) {
    if (Array.isArray(libs[dest])) {
      async.map(libs[dest], function(p, innercb) {
        fs.readFile(path.join(paths.mod, p), innercb);
      }, function(err, data) {
        out[dest] = Buffer.concat(data);
        cb(err);
      });
    } else {
      fs.readFile(path.join(paths.mod, libs[dest]), function(err, data) {
        out[dest] = data;
        cb(err);
      });
    }
  }, function(err) {
    // Prefix PS urls
    Object.keys(out).some(function(file) {
      if (file === "ps.css") {
        out[file] = buf(String(out[file]).replace(/url\(/gm, "url(!/res/lib/"));
      }
    });

    if (minify) {
      Object.keys(out).forEach(function(file) {
        if (/\.js$/.test(file)) {
          out[file] = buf(minifyJS(String(out[file])));
        } else if (/\.css$/.test(file)) {
          out[file] = buf(minifyCSS(String(out[file])));
        }
      });
    }

    callback(err, out);
  });
}

function minifyJS(js) {
  if (!minify) return js;
  return uglify.minify(js, opts.uglify).code;
}

function minifyCSS(css) {
  if (!minify) return css;
  return cleanCSS.minify(String(css)).styles;
}

function templates() {
  const prefix = "(function(){var template=Handlebars.template," +
    "templates=Handlebars.templates=Handlebars.templates||{};";
  const suffix = "Handlebars.partials=Handlebars.templates})();";

  return prefix + fs.readdirSync(paths.templates).map(function(file) {
    const p = path.join(paths.templates, file);
    const name = file.replace(/\..+$/, "");
    let html = htmlMinifier.minify(fs.readFileSync(p, "utf8"), opts.htmlMinifier);

    // remove whitespace around {{fragments}}
    html = html.replace(/(>|^|}}) ({{|<|$)/g, "$1$2");

    // trim whitespace inside {{fragments}}
    html = html.replace(/({{2,})([\s\S\n]*?)(}{2,})/gm, function(_, p1, p2, p3) {
      return p1 + p2.replace(/\n/gm, " ").replace(/ {2,}/gm, " ").trim() + p3;
    }).trim();

    // remove {{!-- comments --}}
    html = html.replace(/{{![\s\S]+?..}}/, "");

    const compiled = handlebars.precompile(html, {data: false});
    return "templates['" + name + "']=template(" + compiled + ");";
  }).join("") + suffix;
}

resources.compileJS = function() {
  let js = "";
  resources.files.js.forEach(function(file) {
    js += fs.readFileSync(path.join(paths.mod, file), "utf8") + ";";
  });

  // Add templates
  js = js.replace("/* {{ templates }} */", templates());

  // Minify
  js = minifyJS(js);

  return {
    data: buf(js),
    etag: etag(js),
    mime: utils.contentType("js"),
  };
};

resources.compileCSS = function() {
  let css = "";
  resources.files.css.forEach(function(file) {
    css += fs.readFileSync(path.join(paths.mod, file), "utf8") + "\n";
  });

  // Vendor prefixes and minify
  css = minifyCSS(postcss([autoprefixer(opts.autoprefixer)]).process(css).css);

  return {
    data: buf(css),
    etag: etag(css),
    mime: utils.contentType("css"),
  };
};

resources.compileHTML = function(res) {
  let html = fs.readFileSync(path.join(paths.mod, "client/index.html"), "utf8");
  html = html.replace("<!-- {{svg}} -->", svg());

  let auth = html.replace("{{type}}", "a");
  auth = minify ? htmlMinifier.minify(auth, opts.htmlMinifier) : auth;
  res["auth.html"] = {data: buf(auth), etag: etag(auth), mime: utils.contentType("html")};

  let first = html.replace("{{type}}", "f");
  first = minify ? htmlMinifier.minify(auth, opts.htmlMinifier) : first;
  res["first.html"] = {data: buf(first), etag: etag(first), mime: utils.contentType("html")};

  let main = html.replace("{{type}}", "m");
  main = minify ? htmlMinifier.minify(main, opts.htmlMinifier) : main;
  res["main.html"] = {data: buf(main), etag: etag(main), mime: utils.contentType("html")};
  return res;
};

function compileAll(callback) {
  let res = {};

  res["client.js"] = resources.compileJS();
  res["style.css"] = resources.compileCSS();
  res = resources.compileHTML(res);

  // Read misc files
  resources.files.other.forEach(function(file) {
    let data;
    const name = path.basename(file);
    const fullPath = path.join(paths.mod, file);

    try {
      data = fs.readFileSync(fullPath);
    } catch (err) {
      callback(err);
    }

    res[name] = {data: data, etag: etag(data), mime: utils.contentType(name)};
  });
  callback(null, res);
}
