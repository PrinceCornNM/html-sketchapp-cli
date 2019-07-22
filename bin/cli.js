#!/usr/bin/env node

const urlJoin = require('url-join');
const findUp = require('find-up');
const { promisify } = require('es6-promisify');
const getPort = require('get-port');
const http = require('http');
const serveHandler = require('serve-handler');
const puppeteer = require('puppeteer');
const { rollup } = require('rollup');
const mkdirpAsync = promisify(require('mkdirp'));
const writeFileAsync = promisify(require('fs').writeFile);
const path = require('path');

const configPath = findUp.sync(['html-sketchapp.config.js']);
const config = configPath ? require(configPath) : {};

const makeServer = async (relativePath, port) => {
  const server = http.createServer((request, response) => {
    return serveHandler(request, response, {
      public: relativePath
    });
  });

  await new Promise((resolve, reject) => {
    server.listen(port, err => err ? reject(err) : resolve());
  });

  return server;
};

const resolveMiddleware = configValue => {
  return (typeof configValue === 'string') ?
    require(path.resolve(process.cwd(), configValue))
    : configValue;
};

require('yargs')
  .config(config)
  .config('config', 'Path to JavaScript config file', customConfigPath => require(customConfigPath))
  .usage('Usage: $0 [options]')
  .command('$0', 'The default command', {
    'serve': {
      alias: 's',
      describe: 'Directory to serve, relative to working directory'
    },
    'url': {
      alias: 'u',
      describe: 'URL to open. When using the "serve" option, URL should be root relative.',
    },
    'file': {
      alias: 'f',
      describe: 'File to open, relative to working directory',
    },
    'out-dir': {
      alias: 'o',
      describe: 'Output directory, relative to working directory',
      demandOption: true
    },
    'viewports': {
      alias: 'v',
      describe: 'Set of named viewport sizes for symbols, e.g. --viewports.Desktop=1024x768 --viewports.Mobile=320x568'
    },
    'debug': {
      alias: 'd',
      describe: 'Put into debug mode to see what the tool is doing'
    },
    'symbol-middleware': {
      describe: 'Path to symbol middleware to run when looping over sketch layers'
    },
    'puppeteer-args': {
      type: 'string',
      describe: 'Set of command line arguments to be provided to the Chromium instance via Puppeteer, e.g. --puppeteer-args="--no-sandbox --disable-setuid-sandbox"'
    },
    'puppeteer-executable-path': {
      type: 'string',
      describe: 'Path to a Chromium executable to use instead of the one downloaded by Puppeteer.'
    },
    'puppeteer-user-data-dir': {
      type: 'string',
      describe: 'Path to a Chromium User Data directory to use instead of the blank temporary one used by Puppeteer.'
    },
    'puppeteer-wait-until': {
      type: 'string',
      describe: 'The Puppeteer navigation event to use before considering the page loaded.',
      default: 'networkidle2',
      choices: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2']
    }
  }, async argv => {
    try {
      const port = argv.serve ? await getPort() : null;
      const server = argv.serve ? await makeServer(argv.serve, port) : null;

      try {
        const url = argv.file ? `file://${path.join(process.cwd(), argv.file)}` : argv.url;
        const symbolsUrl = argv.serve ? urlJoin(`http://localhost:${String(port)}`, argv.url || '/') : url;
        const debug = argv.debug;

        const launchArgs = {
            args: argv.puppeteerArgs ? argv.puppeteerArgs.split(' ') : [],
            executablePath: argv.puppeteerExecutablePath,
            headless: !debug,
            userDataDir: argv.puppeteerUserDataDir
        };

        const browser = await puppeteer.launch(launchArgs);

        try {
          const page = await browser.newPage();

          if (debug) {
            page.bringToFront();
            page.on('console', msg => console.log('PAGE LOG:', msg.text()));
          }

          await page.goto(symbolsUrl, { waitUntil: argv.puppeteerWaitUntil });

          // replace the next section with the page2layers
          await page.addScriptTag({
            path: path.resolve(__dirname, './page2layers.bundle.js')
          });

          // JSON.parse + JSON.stringify hack is only needed until
          // https://github.com/GoogleChrome/puppeteer/issues/1510 is fixed

          const asketchPageJSONStringPromises = [];
          const viewports = argv.viewports || { Desktop: '1024x768' };
          let asketchPageJSONString;
          let asketchPageJSONPromise;
          for (const viewportName in viewports) {
            if (viewports.hasOwnProperty(viewportName)) {
              const viewport = viewports[viewportName];
              const [ size, scale ] = viewport.split('@');
              const [ width, height ] = size.split('x').map(x => parseInt(x, 10));
              const deviceScaleFactor = typeof scale === 'undefined' ? 1 : parseFloat(scale);
              await page.setViewport({ width, height, deviceScaleFactor });

              asketchPageJSONString = await page.evaluate(
                'JSON.stringify(page2layers.run())'
              );

              const outputPath = path.resolve(process.cwd(), argv.outDir);
              await mkdirpAsync(outputPath);

              const outputPagePath = path.join(outputPath, `page-${viewport}.asketch.json`);
              asketchPageJSONPromise = writeFileAsync(outputPagePath, asketchPageJSONString);
              asketchPageJSONStringPromises.push(asketchPageJSONPromise);
            }
          }

          await Promise.all(asketchPageJSONStringPromises);
        } finally {
          if (browser && typeof browser.close === 'function' && !debug) {
            browser.close();
          }
        }
      } finally {
        if (server && typeof server.close === 'function') {
          server.close();
        }
      }
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  })
  .command('install', 'Install the html-sketchapp Sketch plugin', {}, async () => {
    const { version } = require('@brainly/html-sketchapp/package.json');
    console.log(`Detected html-sketchapp v${version}`);

    const tmpDirPath = path.resolve(__dirname, '../', '.tmp');
    const rimrafAsync = promisify(require('rimraf'));
    await rimrafAsync(tmpDirPath);
    await mkdirpAsync(tmpDirPath);

    const [ major, minor, patch ] = version.split('.');
    const releaseUrl = `http://github.com/brainly/html-sketchapp/releases/download/v${version}/asketch2sketch-${major}-${minor}-${patch}.sketchplugin.zip`;
    console.log(`Downloading from ${releaseUrl}`);
    const axios = require('axios');
    const { data } = await axios(releaseUrl, { responseType: 'arraybuffer' });

    console.log(`Extracting to ${tmpDirPath}`);
    const decompress = require('decompress');
    await decompress(data, tmpDirPath);

    const pluginPath = path.resolve(tmpDirPath, 'asketch2sketch.sketchplugin');
    console.log(`Installing from ${pluginPath}`);
    const opn = require('opn');
    opn(pluginPath, { wait: false });
  })
  .parse();
