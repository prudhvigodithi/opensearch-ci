/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * The OpenSearch Contributors require contributions made to
 * this file be licensed under the Apache-2.0 license or a
 * compatible open source license.
 */

import {
  CfnOutput, CfnParameter, Fn, Stack, StackProps,
} from 'aws-cdk-lib';
import {
  FlowLogDestination, FlowLogTrafficType, IPeer, Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { ListenerCertificate } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { CiAuditLogging } from './auditing/ci-audit-logging';
import { CIConfigStack } from './ci-config-stack';
import { AgentNodeProps } from './compute/agent-node-config';
import { AgentNodes } from './compute/agent-nodes';
import { JenkinsMainNode } from './compute/jenkins-main-node';
import { RunAdditionalCommands } from './compute/run-additional-commands';
import { JenkinsMonitoring } from './monitoring/ci-alarms';
import { JenkinsExternalLoadBalancer } from './network/ci-external-load-balancer';
import { JenkinsSecurityGroups } from './security/ci-security-groups';

export interface CIStackProps extends StackProps {
  /** Should the Jenkins use https  */
  readonly useSsl?: boolean;
  /** Should an OIDC provider be installed on Jenkins. */
  readonly runWithOidc?: boolean;
  /** Additional verification during deployment and resource startup. */
  readonly ignoreResourcesFailures?: boolean;
  /** Users with admin access during initial deployment */
  readonly adminUsers?: string[];
  /** Additional logic that needs to be run on Master Node. The value has to be path to a file */
  readonly additionalCommands?: string;
  /** Do you want to retain jenkins jobs and build history */
  readonly dataRetention?: boolean;
  /** IAM role ARN to be assumed by jenkins agent nodes eg: cross-account */
  readonly agentAssumeRole?: string[];
  /** File path containing global environment variables to be added to jenkins enviornment */
  readonly envVarsFilePath?: string;
  /** Add Mac agent to jenkins */
  readonly macAgent?: boolean;
  /** Restrict jenkins access to */
  readonly restrictServerAccessTo?: IPeer;
  /** Use Production Agents */
  readonly useProdAgents?: boolean;
}

export class CIStack extends Stack {
  public readonly monitoring: JenkinsMonitoring;

  public readonly agentNodes: AgentNodeProps[];

  constructor(scope: Construct, id: string, props: CIStackProps) {
    super(scope, id, props);

    const auditloggingS3Bucket = new CiAuditLogging(this);
    const vpc = new Vpc(this, 'JenkinsVPC', {
      flowLogs: {
        s3: {
          destination: FlowLogDestination.toS3(auditloggingS3Bucket.bucket, 'vpcFlowLogs'),
          trafficType: FlowLogTrafficType.ALL,
        },
      },
    });
    const macAgentParameter = `${props?.macAgent ?? this.node.tryGetContext('macAgent')}`;

    const useSslParameter = `${props?.useSsl ?? this.node.tryGetContext('useSsl')}`;
    if (useSslParameter !== 'true' && useSslParameter !== 'false') {
      throw new Error('useSsl parameter is required to be set as - true or false');
    }

    const useSsl = useSslParameter === 'true';

    const runWithOidcParameter = `${props?.runWithOidc ?? this.node.tryGetContext('runWithOidc')}`;
    if (runWithOidcParameter !== 'true' && runWithOidcParameter !== 'false') {
      throw new Error('runWithOidc parameter is required to be set as - true or false');
    }

    let useProdAgents = `${props?.useProdAgents ?? this.node.tryGetContext('useProdAgents')}`;
    if (useProdAgents.toString() === 'undefined') {
      useProdAgents = 'false';
    }

    const runWithOidc = runWithOidcParameter === 'true';

    const additionalCommandsContext = `${props?.additionalCommands ?? this.node.tryGetContext('additionalCommands')}`;

    // Setting CfnParameters to record the value in cloudFormation
    new CfnParameter(this, 'runWithOidc', {
      description: 'If the jenkins instance should use OIDC + federate',
      default: runWithOidc,
    });

    // Setting CfnParameters to record the value in cloudFormation
    new CfnParameter(this, 'useSsl', {
      description: 'If the jenkins instance should be access via SSL',
      default: useSsl,
    });

    const securityGroups = new JenkinsSecurityGroups(this, vpc, useSsl, props?.restrictServerAccessTo);
    const importedContentsSecretBucketValue = Fn.importValue(`${CIConfigStack.CERTIFICATE_CONTENTS_SECRET_EXPORT_VALUE}`);
    const importedContentsChainBucketValue = Fn.importValue(`${CIConfigStack.CERTIFICATE_CHAIN_SECRET_EXPORT_VALUE}`);
    const importedCertSecretBucketValue = Fn.importValue(`${CIConfigStack.PRIVATE_KEY_SECRET_EXPORT_VALUE}`);
    const importedArnSecretBucketValue = Fn.importValue(`${CIConfigStack.CERTIFICATE_ARN_SECRET_EXPORT_VALUE}`);
    const importedRedirectUrlSecretBucketValue = Fn.importValue(`${CIConfigStack.REDIRECT_URL_SECRET_EXPORT_VALUE}`);
    const importedOidcConfigValuesSecretBucketValue = Fn.importValue(`${CIConfigStack.OIDC_CONFIGURATION_VALUE_SECRET_EXPORT_VALUE}`);
    const certificateArn = Secret.fromSecretCompleteArn(this, 'certificateArn', importedArnSecretBucketValue.toString());
    const importedReloadPasswordSecretsArn = Fn.importValue(`${CIConfigStack.CASC_RELOAD_TOKEN_SECRET_EXPORT_VALUE}`);
    const listenerCertificate = ListenerCertificate.fromArn(certificateArn.secretValue.toString());
    const agentNode = new AgentNodes(this);

    if (useProdAgents.toString() === 'true') {
      // eslint-disable-next-line no-console
      console.warn('Please note that if you have decided to use the provided production jenkins agents then '
        + 'please make sure that you are deploying the stack in US-EAST-1 region as the AMIs used are only publicly '
        + 'available in US-EAST-1 region. '
        + 'If you want to deploy the stack in another region then please make sure you copy the public AMIs used '
        + 'from us-east-1 region to your region of choice and update the ami-id in agent-nodes.ts file accordingly. '
        + 'If you do not copy the AMI in required region and update the code then the jenkins agents will not spin up.');

      this.agentNodes = [agentNode.AL2_X64, agentNode.AL2_X64_DOCKER_HOST, agentNode.AL2_X64_DOCKER_HOST_PERF_TEST,
        agentNode.AL2_ARM64, agentNode.AL2_ARM64_DOCKER_HOST, agentNode.UBUNTU2004_X64_GRADLE_CHECK, agentNode.UBUNTU2004_X64_DOCKER_BUILDER,
        agentNode.MACOS12_X64_MULTI_HOST, agentNode.WINDOWS2019_X64, agentNode.WINDOWS2019_X64_GRADLE_CHECK];
    } else {
      this.agentNodes = [agentNode.AL2_X64_DEFAULT_AGENT, agentNode.AL2_ARM64_DEFAULT_AGENT];
    }

    const mainJenkinsNode = new JenkinsMainNode(this, {
      vpc,
      sg: securityGroups.mainNodeSG,
      efsSG: securityGroups.efsSG,
      dataRetention: props.dataRetention ?? false,
      envVarsFilePath: props.envVarsFilePath ?? '',
      reloadPasswordSecretsArn: importedReloadPasswordSecretsArn.toString(),
      sslCertContentsArn: importedContentsSecretBucketValue.toString(),
      sslCertChainArn: importedContentsChainBucketValue.toString(),
      sslCertPrivateKeyContentsArn: importedCertSecretBucketValue.toString(),
      redirectUrlArn: importedRedirectUrlSecretBucketValue.toString(),
      oidcCredArn: importedOidcConfigValuesSecretBucketValue.toString(),
      useSsl,
      runWithOidc,
      failOnCloudInitError: props?.ignoreResourcesFailures,
      adminUsers: props?.adminUsers,
      agentNodeSecurityGroup: securityGroups.agentNodeSG.securityGroupId,
      subnetId: vpc.publicSubnets[0].subnetId,
    }, this.agentNodes, macAgentParameter.toString(), props?.agentAssumeRole);

    const externalLoadBalancer = new JenkinsExternalLoadBalancer(this, {
      vpc,
      sg: securityGroups.externalAccessSG,
      targetInstance: mainJenkinsNode.ec2Instance,
      listenerCertificate,
      useSsl,
    });

    const artifactBucket = new Bucket(this, 'BuildBucket');

    this.monitoring = new JenkinsMonitoring(this, externalLoadBalancer, mainJenkinsNode);

    if (additionalCommandsContext.toString() !== 'undefined') {
      new RunAdditionalCommands(this, additionalCommandsContext.toString());
    }

    new CfnOutput(this, 'Artifact Bucket Arn', {
      value: artifactBucket.bucketArn.toString(),
      exportName: 'buildBucketArn',
    });
  }
}
