let childProcess = require('child_process')
let escalade = require('escalade/sync')
let pico = require('picocolors')
let path = require('path')
let fs = require('fs')

const DEFAULT_INDENT = '  '
const INDENT_REGEXP = /^(\s+)[^\s]/m

function detectIndent(text) {
  try {
    return INDENT_REGEXP.exec(text)[1] || DEFAULT_INDENT
  } catch (e) {
    /* c8 ignore next 2 */
    return DEFAULT_INDENT
  }
}

function BrowserslistUpdateError(message) {
  this.name = 'BrowserslistUpdateError'
  this.message = message
  this.browserslist = true
  if (Error.captureStackTrace) {
    Error.captureStackTrace(this, BrowserslistUpdateError)
  }
}

BrowserslistUpdateError.prototype = Error.prototype

/* c8 ignore next 3 */
function defaultPrint(str) {
  process.stdout.write(str)
}

function detectLockfile() {
  let packageDir = escalade('.', (dir, names) => {
    return names.indexOf('package.json') !== -1 ? dir : ''
  })

  if (!packageDir) {
    throw new BrowserslistUpdateError(
      'Cannot find package.json. ' +
        'Is this the right directory to run `npx update-browserslist-db` in?'
    )
  }

  let lockfileNpm = path.join(packageDir, 'package-lock.json')
  let lockfileShrinkwrap = path.join(packageDir, 'npm-shrinkwrap.json')
  let lockfileYarn = path.join(packageDir, 'yarn.lock')
  let lockfilePnpm = path.join(packageDir, 'pnpm-lock.yaml')

  if (fs.existsSync(lockfilePnpm)) {
    return { mode: 'pnpm', file: lockfilePnpm }
  } else if (fs.existsSync(lockfileNpm)) {
    return { mode: 'npm', file: lockfileNpm }
  } else if (fs.existsSync(lockfileYarn)) {
    let lock = { mode: 'yarn', file: lockfileYarn }
    lock.content = fs.readFileSync(lock.file).toString()
    lock.version = /# yarn lockfile v1/.test(lock.content) ? 1 : 2
    return lock
  } else if (fs.existsSync(lockfileShrinkwrap)) {
    return { mode: 'npm', file: lockfileShrinkwrap }
  }
  throw new BrowserslistUpdateError(
    'No lockfile found. Run "npm install", "yarn install" or "pnpm install"'
  )
}

function getLatestInfo(lock) {
  if (lock.mode === 'yarn') {
    if (lock.version === 1) {
      return JSON.parse(
        childProcess.execSync('yarn info caniuse-lite --json').toString()
      ).data
    } else {
      return JSON.parse(
        childProcess.execSync('yarn npm info caniuse-lite --json').toString()
      )
    }
  }
  return JSON.parse(
    childProcess.execSync('npm show caniuse-lite --json').toString()
  )
}

function getBrowsers() {
  let browserslist = require('browserslist')
  return browserslist().reduce((result, entry) => {
    if (!result[entry[0]]) {
      result[entry[0]] = []
    }
    result[entry[0]].push(entry[1])
    return result
  }, {})
}

function diffBrowsers(old, current) {
  let browsers = Object.keys(old).concat(
    Object.keys(current).filter(browser => old[browser] === undefined)
  )
  return browsers
    .map(browser => {
      let oldVersions = old[browser] || []
      let currentVersions = current[browser] || []
      let common = oldVersions.filter(v => currentVersions.includes(v))
      let added = currentVersions.filter(v => !common.includes(v))
      let removed = oldVersions.filter(v => !common.includes(v))
      return removed
        .map(v => pico.red('- ' + browser + ' ' + v))
        .concat(added.map(v => pico.green('+ ' + browser + ' ' + v)))
    })
    .reduce((result, array) => result.concat(array), [])
    .join('\n')
}

function updateNpmLockfile(lock, latest) {
  let metadata = { latest, versions: [] }
  let content = deletePackage(JSON.parse(lock.content), metadata)
  metadata.content = JSON.stringify(content, null, detectIndent(lock.content))
  return metadata
}

function deletePackage(node, metadata) {
  if (node.dependencies) {
    if (node.dependencies['caniuse-lite']) {
      let version = node.dependencies['caniuse-lite'].version
      metadata.versions[version] = true
      delete node.dependencies['caniuse-lite']
    }
    for (let i in node.dependencies) {
      node.dependencies[i] = deletePackage(node.dependencies[i], metadata)
    }
  }
  return node
}

let yarnVersionRe = /version "(.*?)"/

function updateYarnLockfile(lock, latest) {
  let blocks = lock.content.split(/(\n{2,})/).map(block => {
    return block.split('\n')
  })
  let versions = {}
  blocks.forEach(lines => {
    if (lines[0].indexOf('caniuse-lite@') !== -1) {
      let match = yarnVersionRe.exec(lines[1])
      versions[match[1]] = true
      if (match[1] !== latest.version) {
        lines[1] = lines[1].replace(
          /version "[^"]+"/,
          'version "' + latest.version + '"'
        )
        lines[2] = lines[2].replace(
          /resolved "[^"]+"/,
          'resolved "' + latest.dist.tarball + '"'
        )
        if (lines.length === 4) {
          lines[3] = latest.dist.integrity
            ? lines[3].replace(
                /integrity .+/,
                'integrity ' + latest.dist.integrity
              )
            : ''
        }
      }
    }
  })
  let content = blocks.map(lines => lines.join('\n')).join('')
  return { content, versions }
}

function updateLockfile(lock, latest) {
  if (!lock.content) lock.content = fs.readFileSync(lock.file).toString()

  if (lock.mode === 'yarn') {
    return updateYarnLockfile(lock, latest)
  } else {
    return updateNpmLockfile(lock, latest)
  }
}

function updatePackageManually(print, lock, latest) {
  let lockfileData = updateLockfile(lock, latest)
  let caniuseVersions = Object.keys(lockfileData.versions).sort()
  if (caniuseVersions.length === 1 && caniuseVersions[0] === latest.version) {
    print(
      'Installed version:  ' +
        pico.bold(pico.green(latest.version)) +
        '\n' +
        pico.bold(pico.green('caniuse-lite is up to date')) +
        '\n'
    )
    return
  }

  if (caniuseVersions.length === 0) {
    caniuseVersions[0] = 'none'
  }
  print(
    'Installed version' +
      (caniuseVersions.length === 1 ? ':  ' : 's: ') +
      pico.bold(pico.red(caniuseVersions.join(', '))) +
      '\n' +
      'Removing old caniuse-lite from lock file\n'
  )
  fs.writeFileSync(lock.file, lockfileData.content)

  let install = lock.mode === 'yarn' ? 'yarn add -W' : lock.mode + ' install'
  print(
    'Installing new caniuse-lite version\n' +
      pico.yellow('$ ' + install + ' caniuse-lite') +
      '\n'
  )
  try {
    childProcess.execSync(install + ' caniuse-lite')
  } catch (e) /* c8 ignore start */ {
    print(
      pico.red(
        '\n' +
          e.stack +
          '\n\n' +
          'Problem with `' +
          install +
          ' caniuse-lite` call. ' +
          'Run it manually.\n'
      )
    )
    process.exit(1)
  } /* c8 ignore end */

  let del = lock.mode === 'yarn' ? 'yarn remove -W' : lock.mode + ' uninstall'
  print(
    'Cleaning package.json dependencies from caniuse-lite\n' +
      pico.yellow('$ ' + del + ' caniuse-lite') +
      '\n'
  )
  childProcess.execSync(del + ' caniuse-lite')
}

function updateWith(print, cmd) {
  print('Updating caniuse-lite version\n' + pico.yellow('$ ' + cmd) + '\n')
  try {
    childProcess.execSync(cmd)
  } catch (e) /* c8 ignore start */ {
    print(pico.red(e.stdout.toString()))
    print(
      pico.red(
        '\n' +
          e.stack +
          '\n\n' +
          'Problem with `' +
          cmd +
          '` call. ' +
          'Run it manually.\n'
      )
    )
    process.exit(1)
  } /* c8 ignore end */
}

module.exports = function updateDB(print = defaultPrint) {
  let lock = detectLockfile()
  let latest = getLatestInfo(lock)

  let listError
  let oldList
  try {
    oldList = getBrowsers()
  } catch (e) {
    listError = e
  }

  print('Latest version:     ' + pico.bold(pico.green(latest.version)) + '\n')

  if (lock.mode === 'yarn' && lock.version !== 1) {
    updateWith(print, 'yarn up -R caniuse-lite')
  } else if (lock.mode === 'pnpm') {
    updateWith(print, 'pnpm up caniuse-lite')
  } else {
    updatePackageManually(print, lock, latest)
  }

  print('caniuse-lite has been successfully updated\n')

  let newList
  if (!listError) {
    try {
      newList = getBrowsers()
    } catch (e) /* c8 ignore start */ {
      listError = e
    } /* c8 ignore end */
  }

  if (listError) {
    print(
      pico.red(
        '\n' +
          listError.stack +
          '\n\n' +
          'Problem with browser list retrieval.\n' +
          'Target browser changes won’t be shown.\n'
      )
    )
  } else {
    let changes = diffBrowsers(oldList, newList)
    if (changes) {
      print('\nTarget browser changes:\n')
      print(changes + '\n')
    } else {
      print('\n' + pico.green('No target browser changes') + '\n')
    }
  }
}
