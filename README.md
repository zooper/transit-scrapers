# NJ Transit Light Rail Scraper

A headless browser scraper that provides real-time Light Rail departure data from Essex Street station via a REST API for Home Assistant integration.

## Features

- 🚋 Real-time Light Rail departures from Essex Street
- 🔄 Automatic GraphQL data interception 
- 📊 Simple REST API for Home Assistant
- 🕒 Northbound and Southbound departure tracking
- ⚡ Lightweight and efficient

## Kubernetes Deployment

This application is deployed using Kubernetes and ArgoCD for GitOps.

### Prerequisites

- Kubernetes cluster with Rancher/RKE2
- ArgoCD installed and configured
- Container registry access (GitHub Container Registry)

### Deployment Files

- `deployment.yaml` - Kubernetes Deployment manifest
- `service.yaml` - Kubernetes Service with LoadBalancer (IP: 192.168.200.56)
- `Dockerfile` - Container image definition
- `.github/workflows/docker.yml` - CI/CD pipeline for building images

### ArgoCD Setup

The deployment includes ArgoCD annotations for automatic image updates. Update the image repository in `deployment.yaml`:

```yaml
annotations:
  argocd-image-updater.argoproj.io/image-list: light-rail-scraper=ghcr.io/your-username/light-rail-scraper
```

### Manual Deployment

```bash
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml
```

## Local Installation

1. Install Node.js (v16 or higher)
2. Install dependencies:
   ```bash
   npm install
   ```

## Usage

### Start the server:
```bash
npm start
```

### Development mode (auto-restart):
```bash
npm run dev
```

## API Endpoints

- `GET /` - Service info
- `GET /api/departures` - All departure data
- `GET /api/northbound` - Next northbound train
- `GET /api/southbound` - Next southbound train
- `GET /api/status` - Scraper status

## Home Assistant Integration

Add these sensors to your `configuration.yaml`:

```yaml
sensor:
  - platform: rest
    name: "Light Rail Northbound"
    resource: "http://192.168.200.56/api/northbound"
    value_template: "{{ value_json.status }}"
    json_attributes:
      - destination
      - time
      - lastUpdated
    scan_interval: 120

  - platform: rest
    name: "Light Rail Southbound"
    resource: "http://192.168.200.56/api/southbound"
    value_template: "{{ value_json.status }}"
    json_attributes:
      - destination
      - time
      - lastUpdated
    scan_interval: 120
```

## Response Format

### /api/northbound or /api/southbound
```json
{
  "status": "in 5 mins",
  "destination": "HOBOKEN TERMINAL LIGHT RAIL STATION",
  "time": "11:27 PM",
  "lastUpdated": "2025-08-03T03:30:00.000Z"
}
```

### /api/departures
```json
{
  "northbound": [
    {
      "destination": "HOBOKEN TERMINAL LIGHT RAIL STATION",
      "time": "11:27 PM",
      "status": "in 11 mins",
      "scheduledTime": "8/2/2025 11:27:00 PM"
    }
  ],
  "southbound": [
    {
      "destination": "8TH STREET LIGHT RAIL STATION",
      "time": "11:36 PM", 
      "status": "in 20 mins",
      "scheduledTime": "8/2/2025 11:36:00 PM"
    }
  ],
  "lastUpdated": "2025-08-03T03:30:00.000Z",
  "status": "success"
}
```

## Troubleshooting

- **No data**: Check if the NJ Transit website is accessible
- **Browser errors**: Try restarting the service
- **Memory issues**: The service automatically manages browser instances

## Notes

- The scraper waits 8 seconds for the page to load completely
- Data is cached to avoid excessive requests
- Only one scraping operation runs at a time
- Browser is reused between requests for efficiency