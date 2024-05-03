const { EC2Client, RunInstancesCommand, TerminateInstancesCommand, waitUntilInstanceRunning } = require("@aws-sdk/client-ec2");
const core = require('@actions/core');
const config = require('./config');

const ec2Client = new EC2Client({
  region: config.input.region,
  maxAttempts: 5,
});

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, label) {
  if (config.input.runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    return [
      '#!/bin/bash',
      `cd "${config.input.runnerHomeDir}"`,
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  } else {
    return [
      '#!/bin/bash',
      'mkdir actions-runner && cd actions-runner',
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      'curl -O -L https://github.com/actions/runner/releases/download/v2.313.0/actions-runner-linux-${RUNNER_ARCH}-2.313.0.tar.gz',
      'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-2.313.0.tar.gz',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  }
}

async function startEc2Instance(label, githubRegistrationToken) {
  const userData = buildUserDataScript(githubRegistrationToken, label).join('\n');
  const encodedUserData = Buffer.from(userData).toString('base64');
  const runInstancesCommandInput = {
    ImageId: config.input.ec2ImageId,
    InstanceType: config.input.ec2InstanceType,
    MaxCount: 1,
    MinCount: 1,
    Monitoring: {
      Enabled: true,
    },
    SecurityGroupIds: [
      config.input.securityGroupId,
    ],
    SubnetId: config.input.subnetId,
    UserData: encodedUserData,
    DisableApiTermination: false,
    DryRun: false,
    EbsOptimized: true,
    IamInstanceProfile: {
      Name: config.input.iamRoleName,
    },
    InstanceInitiatedShutdownBehavior: "terminate",
    TagSpecifications: config.tagSpecifications,
    MaintenanceOptions: {
      AutoRecovery: "disabled",
    },
  };
  const runInstancesCommand = new RunInstancesCommand(runInstancesCommandInput);

  try {
    const response = await ec2Client.send(runInstancesCommand);
    const ec2InstanceId = response.Instances[0].InstanceId;
    core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
    return ec2InstanceId;
  } catch (error) {
    core.error('AWS EC2 instance starting error');
    throw error;
  }
}

async function terminateEc2Instance() {
  const terminateInstancesCommandInput = {
    InstanceIds: [
      config.input.ec2InstanceId,
    ],
    DryRun: false,
  };
  const terminateInstancesCommand = new TerminateInstancesCommand(terminateInstancesCommandInput);

  try {
    const response = await ec2Client.send(terminateInstancesCommand);
    const currentState = response.TerminatingInstances[0].CurrentState.Name;
    const previousState = response.TerminatingInstances[0].PreviousState.Name;
    core.debug(`AWS EC2 instance ${config.input.ec2InstanceId} transitioned from ${previousState} to ${currentState}`);
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);
  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId) {
  try {
    await waitUntilInstanceRunning({ client: ec2Client, maxWaitTime: 300, minDelay: 10 }, { InstanceIds: [ ec2InstanceId ] })
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
};
