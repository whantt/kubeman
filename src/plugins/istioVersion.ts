import {ActionGroupSpec, ActionContextType, ActionOutputStyle, ActionOutput, ActionContextOrder} from '../actions/actionSpec'
import K8sFunctions from '../k8s/k8sFunctions'
import IstioFunctions from '../k8s/istioFunctions'
import IstioPluginHelper from '../k8s/istioPluginHelper'
import { K8sClient } from '../k8s/k8sClient';

async function showIstioComponentVersion(cluster: string, deploymentName: string, 
                                          k8sClient: K8sClient, output: ActionOutput) {
  try {
    const deployment = await K8sFunctions.getDeploymentDetails(cluster, "istio-system", deploymentName, k8sClient)
    let versionLabel = deployment ? deployment.template.labels.filter(l => l.includes("version")) : undefined
    if(deployment && (!versionLabel || versionLabel.length === 0)) {
      versionLabel = deployment.template.containers.map(c => c.name + ": " + c.image)
    }
    output.push([deploymentName, versionLabel ? versionLabel : "N/A"])
  } catch(error) {
    output.push([deploymentName, "Not Deployed"])
  }
}

const plugin : ActionGroupSpec = {
  context: ActionContextType.Istio,
  title: "More Istio Recipes",
  order: ActionContextOrder.Istio+4,
  actions: [
    {
      name: "View Istio Versions",
      order: 101,
      
      async act(actionContext) {
        const clusters = actionContext.getClusters()
        this.onOutput && this.onOutput([["", "Istio Version"]], ActionOutputStyle.Table)
        this.showOutputLoading && this.showOutputLoading(true)

        for(const cluster of clusters) {
          this.onStreamOutput  && this.onStreamOutput([[">Cluster: " + cluster.name, ""]])
          if(!cluster.hasIstio) {
            this.onStreamOutput  && this.onStreamOutput([["", "Istio not installed"]])
            continue
          }
          const output: ActionOutput = []
          const k8sClient = cluster.k8sClient
          const deployments = await K8sFunctions.getDeploymentListForNamespace("istio-system", k8sClient)
          for(const deployment of deployments) {
            await showIstioComponentVersion(cluster.name, deployment, k8sClient, output)
          }
          this.onStreamOutput && this.onStreamOutput(output)
        }
        this.showOutputLoading && this.showOutputLoading(false)
      },
    }
  ]
}

export default plugin
