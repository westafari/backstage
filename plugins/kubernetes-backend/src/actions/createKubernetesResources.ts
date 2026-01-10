/*
 * Copyright 2025 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  ActionsRegistryService,
  ActionsRegistryPromptOptions,
  ActionsRegistryResourceOptions,
} from '@backstage/backend-plugin-api/alpha';
import {
  KubernetesClustersSupplier,
  KubernetesObjectsProvider,
} from '@backstage/plugin-kubernetes-node';
import { CatalogService } from '@backstage/plugin-catalog-node';
import { parseEntityRef } from '@backstage/catalog-model';

export function createKubernetesResources(options: {
  actionsRegistry: ActionsRegistryService;
  clusterSupplier: KubernetesClustersSupplier;
  objectsProvider: KubernetesObjectsProvider;
  catalog: CatalogService;
}) {
  const { actionsRegistry, clusterSupplier, objectsProvider, catalog } =
    options;

  // Resource: List all Kubernetes clusters
  actionsRegistry.registerResource({
    name: 'kubernetes-clusters',
    uri: 'kubernetes://clusters',
    title: 'Kubernetes Clusters',
    description: 'List all configured Kubernetes clusters',
    mimeType: 'application/json',
    handler: async (_uri, _params, { credentials }) => {
      const clusters = await clusterSupplier.getClusters({ credentials });

      const clusterSummary = clusters.map(cluster => ({
        name: cluster.name,
        title: cluster.title,
        dashboardUrl: cluster.dashboardUrl,
        dashboardApp: cluster.dashboardApp,
      }));

      return {
        contents: [
          {
            uri: 'kubernetes://clusters',
            text: JSON.stringify(clusterSummary, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    },
  } as ActionsRegistryResourceOptions);

  // Resource: Get all Kubernetes workloads for an entity
  actionsRegistry.registerResource({
    name: 'kubernetes-workloads',
    uri: 'kubernetes://workloads/{entityRef}',
    title: 'Kubernetes Workloads',
    description:
      'Get Kubernetes resources (pods, deployments, services, etc.) for a catalog entity',
    mimeType: 'application/json',
    handler: async (uri, params, { credentials }) => {
      const entityRef = parseEntityRef(params.entityRef);
      const entity = await catalog.getEntityByRef(entityRef, { credentials });

      if (!entity) {
        throw new Error(`Entity not found: ${params.entityRef}`);
      }

      const response = await objectsProvider.getKubernetesObjectsByEntity(
        {
          entity,
          auth: {},
        },
        { credentials },
      );

      // Simplify the response for AI consumption
      const summary = response.items.map(clusterObjects => {
        const resources: Record<string, any[]> = {};

        clusterObjects.resources.forEach(resource => {
          resources[resource.type] = resource.resources;
        });

        return {
          cluster: clusterObjects.cluster.name,
          resources,
          errors: clusterObjects.errors,
        };
      });

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(summary, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    },
  } as ActionsRegistryResourceOptions);

  // Resource: Get pod status for an entity
  actionsRegistry.registerResource({
    name: 'kubernetes-pod-status',
    uri: 'kubernetes://pods/{entityRef}',
    title: 'Kubernetes Pod Status',
    description: 'Get pod status and health for a catalog entity',
    mimeType: 'application/json',
    handler: async (uri, params, { credentials }) => {
      const entityRef = parseEntityRef(params.entityRef);
      const entity = await catalog.getEntityByRef(entityRef, { credentials });

      if (!entity) {
        throw new Error(`Entity not found: ${params.entityRef}`);
      }

      const response = await objectsProvider.getKubernetesObjectsByEntity(
        {
          entity,
          auth: {},
        },
        { credentials },
      );

      // Extract and summarize pod information
      const podSummary = response.items.flatMap(clusterObjects => {
        const podResource = clusterObjects.resources.find(
          r => r.type === 'pods',
        );
        if (!podResource || podResource.type !== 'pods') {
          return [];
        }

        return podResource.resources.map(pod => ({
          name: pod.metadata?.name,
          namespace: pod.metadata?.namespace,
          cluster: clusterObjects.cluster.name,
          phase: pod.status?.phase,
          conditions: pod.status?.conditions?.map(c => ({
            type: c.type,
            status: c.status,
            reason: c.reason,
            message: c.message,
          })),
          containers: pod.status?.containerStatuses?.map(c => ({
            name: c.name,
            ready: c.ready,
            restartCount: c.restartCount,
            state: c.state,
          })),
          hostIP: pod.status?.hostIP,
          podIP: pod.status?.podIP,
          startTime: pod.status?.startTime,
        }));
      });

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(podSummary, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    },
  } as ActionsRegistryResourceOptions);

  // Prompt: Guide for using Kubernetes resources
  actionsRegistry.registerPrompt({
    name: 'kubernetes-guide',
    title: 'Kubernetes Resources Guide',
    description: 'How to query Kubernetes resources for Backstage entities',
    template: `
The Kubernetes plugin shows live cluster resources for catalog entities.

Available Resources:
- kubernetes://clusters - List all configured Kubernetes clusters
- kubernetes://workloads/{entityRef} - All Kubernetes resources for an entity
- kubernetes://pods/{entityRef} - Pod status and health for an entity

Entity Reference Format:
Use the format: kind:namespace/name
Examples:
- component:default/my-service
- api:production/payment-api
- system:default/shopping-cart

Entity Requirements:
Entities must have Kubernetes annotations to be discoverable:
- backstage.io/kubernetes-id: Label selector to match Kubernetes resources
- backstage.io/kubernetes-namespace: Kubernetes namespace (optional)

Common Queries:
- "What Kubernetes clusters are configured?" → kubernetes://clusters
- "Show pods for my-service" → kubernetes://pods/component:default/my-service
- "What resources does payment-api have?" → kubernetes://workloads/component:default/payment-api
- "Is my deployment healthy?" → kubernetes://pods/component:default/my-app

Resource Types Available:
The workloads resource includes:
- pods: Running containers and their status
- deployments: Deployment configurations and replicas
- services: Service endpoints and load balancers
- replicasets: Replica set status
- statefulsets: Stateful applications
- daemonsets: Node-level services
- jobs: Batch jobs
- cronjobs: Scheduled jobs
- ingresses: HTTP routing rules
- configmaps: Configuration data
- horizontalpodautoscalers: Auto-scaling configuration

All resources are read-only and reflect the current state of your Kubernetes clusters.
    `.trim(),
  } as ActionsRegistryPromptOptions<any>);
}
