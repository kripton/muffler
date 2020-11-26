#!/usr/bin/env node

const fs = require('fs');
const process = require('process');
const os = require('os');
const child = require('child_process');

let confFileName = '';
let conf = {};
let loDev = '';

// ########################################
// ### OUTPUT HELPERS #####################
// ########################################
{
function phase(num, name) {
    console.log('########################################');
    let str = '### PHASE ' +  num + ': ' + name + ' ';
    while (str.length < 20) {
        str += '#';
    }
    console.log(str);
    console.log('########################################');
}

function cutLine() {
    console.log('---8<---8<---8<---8<---8<---8<---8<---');
}

function formatChildOutput(content) {
    let cont = '';
    if ((content.stderr) && (content.stderr.toString().length)) {
        cont = content.stderr.toString() + "\n" + content.stdout.toString();
    } else {
        cont = content.stdout.toString();
    }
    cutLine();
    console.log(cont.replace(/^/gm, ">  "));
    cutLine();
    console.log('');
}
}

try {

// ########################################
// ### PHASE 1: Santiy check + read cfg ###
// ########################################
{
phase(1, 'Santiy check + read cfg');

// First given parameter must be the name of the config
if (process.argv.length == 2) {
    throw('No config file name given');
}
confFileName = process.argv[2];
if (!fs.existsSync(confFileName)) {
    throw('Config file given on the command line does not exist');
}
if (!fs.statSync(confFileName).isFile()) {
    throw('Config file given on the command line is not a file');
}

// Fail if we don't run as root
const uName = os.userInfo().username;
console.log('Running as user "' + uName + '"');
if (uName !== 'root') {
    throw('This program needs to be run as root');
}

// Read the config file
const configContent = fs.readFileSync(confFileName);
conf = JSON.parse(configContent);
if (!conf.outfile.filename) {
    console.warn("!!! Output filename not specified in config. Deriving it form the config's name");
    conf.outfile.filename = confFileName.split('.')[0] + '.img';
}
}

// ########################################
// ### PHASE 2: Prepare output file #######
// ########################################
{
phase(2, 'Prepare output file');

if (!conf.outfile.filename || !conf.outfile.size) {
    throw('outfile.filename or outfile.size not defined in config');
}

child.execSync('truncate -s 0 ' + conf.outfile.filename);
child.execSync('truncate -s ' + conf.outfile.size + ' ' + conf.outfile.filename);

loDev = child.execSync('losetup -f --show ' + conf.outfile.filename).toString().trim();

console.log('Loopback device: ' + loDev);
if (!loDev.startsWith('/dev/loop')) {
    throw('Sanity check error: Loop device does not start with "/dev/loop"')
}
try {
    console.log('Partition table PRE PARTITION (okay if it shows failure):');
    formatChildOutput(child.spawnSync('parted', ['-a', 'optimal', '-s', loDev, 'unit', 'MB', 'print']));
} catch(e) {
};
// TODO: Sanity check: partition table PRE HAS to be empty in order to continue!
//       Otherwise we risk re-parititioning something not related to us

child.execSync('parted -a optimal -s ' + loDev + ' mklabel msdos');
child.execSync('parted -a optimal -s ' + loDev + ' mkpart primary fat32 0% 500');
child.execSync('parted -a optimal -s ' + loDev + ' set 1 boot on');
child.execSync('parted -a optimal -s ' + loDev + ' mkpart primary ext4 500 100%');

try {
    console.log('Partition table POST PARTITION: ');
    formatChildOutput(child.spawnSync('parted', ['-a', 'optimal', '-s', loDev, 'unit', 'MB', 'print']));
} catch(e) {};

child.execSync('partprobe ' + loDev);

console.log('Partition contents PRE FORMAT:');
formatChildOutput(child.spawnSync('file', ['-sL', loDev + 'p1', loDev + 'p2']));

var rootFsLabel = 'GentooRoot';
if ((conf.outfile.rootFsLabel) && (conf.outfile.rootFsLabel.length <= 16)) {
    rootFsLabel = conf.outfile.rootFsLabel;
}

formatChildOutput(child.spawnSync('mkfs.vfat', ['-n', 'BOOT', loDev + 'p1']));
formatChildOutput(child.spawnSync('mkfs.ext4', ['-L', rootFsLabel, loDev + 'p2']));

console.log('Partition contents POST FORMAT:');
formatChildOutput(child.spawnSync('file', ['-sL', loDev + 'p1', loDev + 'p2']));
}

// ########################################
// ### PHASE 3: Install base system #######
// ########################################
phase(3, 'Install base system');
{
fs.rmdirSync('sysRootMount', {recursive: true});
fs.mkdirSync('sysRootMount');
formatChildOutput(child.spawnSync('mount', [loDev + 'p2', 'sysRootMount']));
console.log('Free space in mounted directory:');
formatChildOutput(child.spawnSync('df', ['-h', 'sysRootMount']));

if (!conf.seedfiles.stage) {
    throw('seedfiles.stage not defined in config');
}
console.log('Fecthing seedfile from "' + conf.seedfiles.stage + '"');
formatChildOutput(child.spawnSync('wget', ['-c', conf.seedfiles.stage]));
const seedFileName = conf.seedfiles.stage.split('/')[conf.seedfiles.stage.split('/').length - 1];
console.log('Unpacking seedfile');
formatChildOutput(child.spawnSync('tar', ['xpf', '../' + seedFileName, "--xattrs-include='*.*'", '--numeric-owner'], {cwd: 'sysRootMount'}));

console.log('Free space in mounted directory:');
formatChildOutput(child.spawnSync('df', ['-h', 'sysRootMount']));
}

// ########################################
// ### PHASE 4: Preparing to chroot #######
// ########################################
phase(4, 'Preparing to chroot');
{
fs.copyFileSync('/etc/resolv.conf', 'sysRootMount/etc/resolv.conf');
formatChildOutput(child.spawnSync('mount', ['--types', 'proc', '/proc', 'sysRootMount/proc']));
formatChildOutput(child.spawnSync('mount', ['--rbind', '/sys', 'sysRootMount/sys']));
formatChildOutput(child.spawnSync('mount', ['--make-rslave', 'sysRootMount/sys']));
formatChildOutput(child.spawnSync('mount', ['--rbind', '/dev', 'sysRootMount/dev']));
formatChildOutput(child.spawnSync('mount', ['--make-rslave', 'sysRootMount/dev']));
formatChildOutput(child.spawnSync('mount', [loDev + 'p1', 'sysRootMount/boot']));

// Have /var/tmp on the host to avoid out-of-space problems
// Don't delete it since it might contain binary packages
fs.mkdirSync('sysRootMountVarTmp');
formatChildOutput(child.spawnSync('mount', ['-o', 'bind', 'sysRootMountVarTmp', 'sysRootMount/var/tmp']));

if (conf.systemconfig.hostname) {
    fs.writeFileSync('sysRootMount/etc/conf.d/hostname', 'hostname="' + conf.systemconfig.hostname + '"');
}

console.log('Copy over additional "preMerge" files:');
for (idx in conf.additionalFiles) {
    const file = conf.additionalFiles[idx];
    if (file.step === 'preMerge') {
        console.log("\t" + file.path);
        // Make sure that the directory to copy to exists
        const targetPath = 'sysRootMount' + file.path;
        const targetDir = targetPath.substring(0, targetPath.lastIndexOf('/') + 1);
        if (!fs.existsSync(targetDir)) {
             fs.mkdirSync(targetDir, {recursive: true});
        }
        fs.copyFileSync(confFileName.split('.')[0] + '.additionalFiles' + file.path, 'sysRootMount' + file.path);
    }
}

// Prepare the world file and some other files in /etc/portage
fs.mkdirSync('sysRootMount' + '/etc/portage/package.accept_keywords/');
let world = '';
let akw = '';
let lic = '';
for (idx in conf.additionalPackages) {
    const pkg = conf.additionalPackages[idx];
    world += pkg.name + "\n";
    if (pkg.accept_keywords) {
        akw += pkg.name + ' ' + pkg.accept_keywords + "\n";
    }
    if (pkg.accept_license) {
        lic += pkg.name + ' ' + pkg.accept_license + "\n";
    }
}
fs.writeFileSync('sysRootMount/var/lib/portage/world', world);
fs.writeFileSync('sysRootMount/etc/portage/package.accept_keywords/muffler', akw);
fs.writeFileSync('sysRootMount/etc/portage/package.license', lic);

// Prepare the script to be run inside the chroot
let chrootScript = "\
#!/bin/bash\n\
echo \"Hello from the chroot!\"\n\
source /etc/profile\n\
env-update\n\
source /etc/profile\n\
emerge-webrsync\n\
eselect profile set " + conf.systemconfig.profile + "\n";

if ((conf.useBinaryPackages) || (conf.generateBinaryPackages)) {
    chrootScript += 'echo "PKGDIR=\\"/var/tmp/binpkgs\\"" >> /etc/portage/make.conf' + "\n";
}

if (conf.useBinaryPackages) {
    chrootScript += "emerge -1uvDN --usepkg @world\n";
} else {
    chrootScript += "emerge -1uvDN @world\n";
}

chrootScript += "emerge -c\n";

if (conf.generateBinaryPackages) {
    chrootScript += "quickpkg --include-config y --include-unmodified-config y @installed\n";
}

// Add and/or prepare the users
for (idx in conf.systemconfig.users) {
    const userInfo = conf.systemconfig.users[idx];
    if (userInfo.name != 'root') {
        chrootScript += "useradd -m " + userInfo.name + "\n";
    }
    if (userInfo.password) {
        chrootScript += 'echo "' + userInfo.name + ':' + userInfo.password + "\" | chpasswd\n";
    }
    if (userInfo.sshkeys) {
        let homedir = '/home/' + userInfo.name + '/';
        if (userInfo.name === 'root') {
            homedir = '/root/';
        }
        chrootScript += 'mkdir ' + homedir + "/.ssh\n";
        for (idx2 in userInfo.sshkeys) {
            chrootScript += 'echo "' + userInfo.sshkeys[idx2] + '" >> ' + homedir + "/.ssh/authorized_keys\n";
        }
        chrootScript += 'chown -Rv ' + userInfo.name + ':' + userInfo.name + ' ' + homedir + "/.ssh\n";
        chrootScript += 'chmod 0400 ' + homedir + "/.ssh/authorized_keys\n";
    }
}

if (conf.promptInChroot) {
    chrootScript += "echo \"Chroot work done, here's your prompt:\"\n\/bin/bash\n";
} else {
    chrootScript += "echo \"Chroot work done, going back to host ...\"\n";
}
fs.writeFileSync('sysRootMount/mufflerScript.sh', chrootScript);
formatChildOutput(child.spawnSync('chmod', ['+x', 'sysRootMount/mufflerScript.sh']));
}

// ########################################
// ### PHASE 5: chrooting #################
// ########################################
phase(5, 'chrooting');
{
console.log('Chrooting ...');
child.spawnSync('chroot', ['sysRootMount', '/mufflerScript.sh'], {stdio: 'inherit'});
console.log('Back from the chroot :)');
fs.unlinkSync('sysRootMount/mufflerScript.sh');

console.log('Copy over additional "postMerge" files:');
for (idx in conf.additionalFiles) {
    const file = conf.additionalFiles[idx];
    if (file.step === 'postMerge') {
        console.log("\t" + file.path);
        // Make sure that the directory to copy to exists
        const targetPath = 'sysRootMount' + file.path;
        const targetDir = targetPath.substring(0, targetPath.lastIndexOf('/') + 1);
        if (!fs.existsSync(targetDir)) {
             fs.mkdirSync(targetDir, {recursive: true});
        }
        fs.copyFileSync(confFileName.split('.')[0] + '.additionalFiles' + file.path, 'sysRootMount' + file.path);
    }
}

console.log('Executing additional scripts');
const additionalScriptFoldername = confFileName.split('.')[0] + '.additionalScripts';
if ((fs.existsSync(additionalScriptFoldername)) && (fs.statSync(additionalScriptFoldername).isDirectory())) {
    const additionalScripts = fs.readdirSync(additionalScriptFoldername);
    for (idx in additionalScripts) {
        const additionalScriptFileName = additionalScripts[idx];
        console.log(additionalScriptFileName);
        fs.copyFileSync(additionalScriptFoldername + '/' + additionalScriptFileName, 'sysRootMount/' + additionalScriptFileName);
        formatChildOutput(child.spawnSync('chmod', ['+x', 'sysRootMount/' + additionalScriptFileName]));
        child.spawnSync('chroot', ['sysRootMount', '/' + additionalScriptFileName], {stdio: 'inherit'});
        fs.unlinkSync('sysRootMount/' + additionalScriptFileName);
    }
}
console.log('Done :)');
}

// ########################################
// ### PHASE 6: Cleanup   #################
// ########################################
phase(5, 'Cleanup');
{
fs.rmdirSync('sysRootMount/var/cache/distfiles', {recursive: true});
fs.rmdirSync('sysRootMount/var/db/repos', {recursive: true});
fs.rmdirSync('sysRootMount/var/tmp/portage', {recursive: true});
formatChildOutput(child.spawnSync('umount', ['-R', 'sysRootMount']));
if (conf.outfile.zerofree) {
    formatChildOutput(child.spawnSync('zerofree', ['-v', loDev + 'p2']));
}
formatChildOutput(child.spawnSync('losetup', ['-d', loDev]));
}

// ########################################
// ### PHASE 7: Compress the image ########
// ########################################
phase(5, 'Compress the image');
{
if (conf.outfile.compress) {
    formatChildOutput(child.spawnSync('pixz', ['-9', '-k', conf.outfile.filename]));
}
}

// ########################################
// ### Error handling #####################
// ########################################
} catch(e) {
    console.error(e);

    // Umount and remove loop device
    try {
        formatChildOutput(child.spawnSync('umount', ['-R', 'sysRootMount']));
    } catch(e) {}
    try {
        if (loDev) {
            formatChildOutput(child.spawnSync('losetup', ['-d', loDev]));
        }
    } catch(e) {}

    process.exit(1);
};
