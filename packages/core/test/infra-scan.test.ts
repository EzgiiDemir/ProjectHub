import { describe, expect, it } from 'vitest';
import { scanInfrastructure } from '../src/scan/infra.js';

const rules = (path: string, content: string) => scanInfrastructure(path, content).map((f) => f.ruleId).sort();

describe('infrastructure scanner', () => {
  it('flags risky Docker Compose services and leaves a hardened one alone', () => {
    const compose = `services:
  db:
    image: postgres:18
    ports: ['5432:5432']
    environment:
      POSTGRES_PASSWORD: hunter2-real
  agent:
    image: example/agent:1.2
    privileged: true
    network_mode: host
    cap_add: [SYS_ADMIN]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
  safe:
    image: example/app:1.0
    ports: ['127.0.0.1:6379:6379']
    environment:
      DB_PASSWORD: \${DB_PASSWORD}
`;
    const found = scanInfrastructure('deploy/docker-compose.yml', compose);
    expect(found.map((f) => f.ruleId).sort()).toEqual([
      'iac/compose-dangerous-capability',
      'iac/compose-docker-socket',
      'iac/compose-exposed-datastore',
      'iac/compose-host-network',
      'iac/compose-inline-secret',
      'iac/compose-privileged',
    ]);
    expect(found.every((f) => !f.description.includes('safe'))).toBe(true);
    // The secret value itself never ends up in the finding.
    expect(JSON.stringify(found)).not.toContain('hunter2-real');
    expect(found.find((f) => f.ruleId === 'iac/compose-privileged')?.line).toBe(9);
  });

  it('flags Kubernetes pod security problems across documents', () => {
    const manifest = `apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  template:
    spec:
      hostNetwork: true
      volumes:
        - name: host
          hostPath: { path: /etc }
      containers:
        - name: app
          image: nginx
          securityContext: { privileged: true, runAsUser: 0 }
---
apiVersion: v1
kind: Pod
metadata: { name: ok }
spec:
  securityContext: { runAsNonRoot: true, runAsUser: 1000 }
  containers:
    - name: ok
      image: nginx:1.27
      resources: { limits: { cpu: '1', memory: 256Mi } }
`;
    expect(rules('k8s/web.yaml', manifest)).toEqual([
      'iac/k8s-host-namespace',
      'iac/k8s-host-path',
      'iac/k8s-no-limits',
      'iac/k8s-privileged',
      'iac/k8s-root-user',
      'iac/k8s-unpinned-image',
    ]);
  });

  it('flags open Terraform ingress, public storage and inline secrets', () => {
    const tf = `resource "aws_security_group" "db" {
  ingress {
    from_port   = 5432
    to_port     = 5432
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_s3_bucket_acl" "b" {
  acl = "public-read"
}
resource "aws_db_instance" "main" {
  publicly_accessible = true
  storage_encrypted   = false
  password            = "S3cretPassw0rd"
}
`;
    expect(rules('infra/main.tf', tf)).toEqual([
      'iac/tf-inline-secret',
      'iac/tf-open-admin-port',
      'iac/tf-open-ingress',
      'iac/tf-public-bucket',
      'iac/tf-public-database',
      'iac/tf-unencrypted-storage',
    ]);
  });

  it('ignores ordinary YAML and malformed files', () => {
    expect(rules('.github/workflows/ci.yml', 'name: ci\non: push\njobs: {}\n')).toEqual([]);
    expect(rules('compose.yaml', 'services: [unclosed')).toEqual([]);
    expect(rules('projecthub.yml', 'version: 1\nbuild: { command: npm run build }\n')).toEqual([]);
  });
});
