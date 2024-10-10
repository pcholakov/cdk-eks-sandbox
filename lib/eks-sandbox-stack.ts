import * as cdk from "aws-cdk-lib";
import { aws_ec2, aws_eks, aws_iam } from "aws-cdk-lib";
import { Construct } from "constructs";
import { KubectlV30Layer } from "@aws-cdk/lambda-layer-kubectl-v30";
import { AccessScopeType, ClusterLoggingTypes } from "aws-cdk-lib/aws-eks";

export class EksSandboxStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: { trustedOperatorRoleArn: string } & cdk.StackProps) {
    super(scope, id, props);

    const trustedOperatorRole = aws_iam.Role.fromRoleArn(this, "Role", props.trustedOperatorRoleArn);

    const cluster = new aws_eks.Cluster(this, "Cluster", {
      defaultCapacity: 0,
      version: aws_eks.KubernetesVersion.V1_30,
      clusterName: "eks-sandbox",
      kubectlLayer: new KubectlV30Layer(this, "KubectlV30Layer"),
      authenticationMode: aws_eks.AuthenticationMode.API_AND_CONFIG_MAP,
      clusterLogging: [
        ClusterLoggingTypes.API,
        ClusterLoggingTypes.AUDIT,
        ClusterLoggingTypes.AUTHENTICATOR,
        ClusterLoggingTypes.CONTROLLER_MANAGER,
        ClusterLoggingTypes.SCHEDULER,
      ],
    });

    const serviceAccountNamespace = "kube-system";
    const serviceAccountName = "ebs-csi-controller-sa";

    const oidcPrincipal = new aws_iam.OpenIdConnectPrincipal(cluster.openIdConnectProvider).withConditions({
      StringEquals: new cdk.CfnJson(this, "ConditionJson", {
        value: {
          [`${cluster.openIdConnectProvider.openIdConnectProviderIssuer}:aud`]: "sts.amazonaws.com",
          [`${cluster.openIdConnectProvider.openIdConnectProviderIssuer}:sub`]: `system:serviceaccount:${serviceAccountNamespace}:${serviceAccountName}`,
        },
      }),
    });

    const ebsCsiControllerRole = new aws_iam.Role(this, "EbsCsiControllerRole", {
      assumedBy: oidcPrincipal,
    });
    ebsCsiControllerRole.addManagedPolicy(
      aws_iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonEBSCSIDriverPolicy"),
    );

    const csiSnapshotController = new aws_eks.CfnAddon(this, "SnapshotControllerAddon", {
      clusterName: cluster.clusterName,
      addonName: "snapshot-controller",
    });

    const ebsCsiDriver = new aws_eks.CfnAddon(this, "EbsCsiDriverAddon", {
      clusterName: cluster.clusterName,
      addonName: "aws-ebs-csi-driver",
      serviceAccountRoleArn: ebsCsiControllerRole.roleArn,
    });
    ebsCsiDriver.addDependency(csiSnapshotController);

    new aws_eks.KubernetesManifest(this, "Gp3StorageClass", {
      cluster,
      manifest: [
        {
          apiVersion: "storage.k8s.io/v1",
          kind: "StorageClass",
          metadata: {
            name: "gp3",
          },
          provisioner: "ebs.csi.aws.com",
          volumeBindingMode: "WaitForFirstConsumer",
          parameters: {
            type: "gp3",
            "csi.storage.k8s.io/fstype": "xfs",
          },
          reclaimPolicy: "Delete",
        },
      ],
    });

    new aws_eks.KubernetesManifest(this, "BackupSnapshotClass", {
      cluster,
      manifest: [
        {
          apiVersion: "snapshot.storage.k8s.io/v1",
          kind: "VolumeSnapshotClass",
          metadata: {
            name: "backup-snapshot",
            // annotations: { "snapshot.storage.kubernetes.io/is-default-class": "true" },
          },
          driver: "ebs.csi.aws.com",
          deletionPolicy: "Delete",
        },
      ],
    });

    cluster.addNodegroupCapacity("Nodegroup0", {
      nodegroupName: "ng-0",
      minSize: 1,
      desiredSize: 1,
      maxSize: 1,
      instanceTypes: [aws_ec2.InstanceType.of(aws_ec2.InstanceClass.T4G, aws_ec2.InstanceSize.SMALL)],
      subnets: {
        subnetType: aws_ec2.SubnetType.PUBLIC,
        availabilityZones: [
          cluster.vpc.publicSubnets[0].availabilityZone,
          cluster.vpc.publicSubnets[1].availabilityZone,
        ],
      },
      labels: { role: "core" },
      capacityType: aws_eks.CapacityType.ON_DEMAND,
    });

    cluster.grantAccess("role", trustedOperatorRole.roleArn, [
      aws_eks.AccessPolicy.fromAccessPolicyName("AmazonEKSClusterAdminPolicy", {
        accessScopeType: AccessScopeType.CLUSTER,
      }),
    ]);

    const kubeAccessRole = new aws_iam.Role(this, "KubeAccessRole", {
      // roleName: "KubeAccessRole", // uncomment if you want to give it a predictable fixed name
      assumedBy: trustedOperatorRole,
    });

    cluster.awsAuth.addRoleMapping(kubeAccessRole, {
      groups: ["kube-access-role"],
    });

    new cdk.CfnOutput(this, "KubeAccessRoleOutput", { value: kubeAccessRole.roleArn });
    new cdk.CfnOutput(this, "ClusterRoleOutput", { value: cluster.role.roleArn });
    new cdk.CfnOutput(this, "ClusterAdminRoleOutput", { value: cluster.adminRole.roleArn });
  }
}
